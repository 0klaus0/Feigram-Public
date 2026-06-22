package main

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha1"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gotd/td/session"
	"github.com/gotd/td/telegram"
	"github.com/gotd/td/telegram/auth"
	"github.com/gotd/td/telegram/auth/qrlogin"
	"github.com/gotd/td/tg"
	"rsc.io/qr"
)

const (
	version         = "0.11.0"
	defaultPartSize = 1024 * 1024
)

var migrateRe = regexp.MustCompile(`(?:FILE|PHONE|NETWORK|USER)?_?MIGRATE_([0-9]+)`)
var floodWaitRe = regexp.MustCompile(`(?i)FLOOD(?:_PREMIUM)?_WAIT[^0-9]*([0-9]+)`)
var floodWaitRPCRe = regexp.MustCompile(`(?i)FLOOD(?:_PREMIUM)?_WAIT.*\(([0-9]+)\)`)

type Config struct {
	Enabled      bool   `json:"enabled"`
	Concurrency  int    `json:"concurrency"`
	RateLimitBps int64  `json:"rateLimitBps"`
	Mode         string `json:"mode"`
	PartSize     int64  `json:"partSize"`
	Backend      string `json:"backend"`
	Transport    string `json:"transport"`
	UpdatedAt    string `json:"updatedAt"`
}

type Task struct {
	ID          string             `json:"id"`
	UserID      string             `json:"userId"`
	AccountID   string             `json:"accountId"`
	PeerID      string             `json:"peerId"`
	MessageID   int64              `json:"messageId"`
	FileName    string             `json:"fileName"`
	ContentType string             `json:"contentType"`
	Kind        string             `json:"kind"`
	Size        int64              `json:"size"`
	Downloaded  int64              `json:"downloaded"`
	SpeedBps    int64              `json:"speedBps"`
	Status      string             `json:"status"`
	Source      string             `json:"source"`
	AutoCache   bool               `json:"autoCache"`
	Transport   string             `json:"transport"`
	SourceURL   string             `json:"sourceUrl"`
	MetadataURL string             `json:"metadataUrl"`
	FilePath    string             `json:"filePath"`
	PartPath    string             `json:"partPath"`
	InlineURL   string             `json:"inlineUrl"`
	NativeFile  NativeFileLocation `json:"nativeFile"`
	NativePeer  NativePeerLocation `json:"nativePeer"`
	Error       string             `json:"error"`
	RetryCount  int                `json:"retryCount"`
	RetryAfter  int64              `json:"retryAfterUnix"`
	Order       int64              `json:"order"`
	CreatedAt   string             `json:"createdAt"`
	UpdatedAt   string             `json:"updatedAt"`
}

type NativeFileLocation struct {
	PeerID        string `json:"peerId"`
	MessageID     int64  `json:"messageId"`
	Kind          string `json:"kind"`
	FileID        string `json:"fileId"`
	AccessHash    string `json:"accessHash"`
	FileReference string `json:"fileReference"`
	DCID          int    `json:"dcId"`
	Size          int64  `json:"size"`
	MimeType      string `json:"mimeType"`
	FileName      string `json:"fileName"`
	UpdatedAt     string `json:"updatedAt"`
}

type NativePeerLocation struct {
	Type       string `json:"type"`
	ID         string `json:"id"`
	AccessHash string `json:"accessHash"`
}

type NativeAccount struct {
	UserID               string             `json:"userId"`
	AccountID            string             `json:"accountId"`
	Phone                string             `json:"phone"`
	DisplayName          string             `json:"displayName"`
	APIID                int                `json:"apiId"`
	APIHash              string             `json:"apiHash"`
	Status               string             `json:"status"`
	Ready                bool               `json:"ready"`
	Session              string             `json:"session"`
	Error                string             `json:"error"`
	HealthPasses         int                `json:"healthPasses"`
	LastHealthBytes      int                `json:"lastHealthBytes"`
	LastHealthDC         int                `json:"lastHealthDc"`
	LastHealthDurationMS int64              `json:"lastHealthDurationMs"`
	HealthFile           NativeFileLocation `json:"healthFile,omitempty"`
	CreatedAt            string             `json:"createdAt"`
	UpdatedAt            string             `json:"updatedAt"`
	CheckedAt            string             `json:"checkedAt"`
}

type NativeLogin struct {
	ID            string
	UserID        string
	AccountID     string
	Phone         string
	APIID         int
	APIHash       string
	CodeHash      string
	Status        string
	NeedsPassword bool
	Code          chan string
	Password      chan string
	Result        chan nativeLoginResult
	StartResult   chan nativeLoginResult
	Cancel        context.CancelFunc
	CreatedAt     time.Time
	UpdatedAt     time.Time
}

type NativeQRLogin struct {
	ID        string
	UserID    string
	AccountID string
	APIID     int
	APIHash   string
	Token     []byte
	URL       string
	QRImage   string
	Status    string
	Error     string
	Done      bool
	Account   NativeAccount
	Cancel    context.CancelFunc
	Ready     chan nativeQRLoginResult
	Expires   time.Time
	CreatedAt time.Time
	UpdatedAt time.Time
}

type nativeLoginResult struct {
	Account          NativeAccount
	Error            error
	LoginID          string
	PhoneCodeHash    string
	PasswordRequired bool
	Done             bool
}

type nativeQRLoginResult struct {
	Account NativeAccount `json:"account,omitempty"`
	LoginID string        `json:"loginId"`
	URL     string        `json:"url,omitempty"`
	QRImage string        `json:"qrImage,omitempty"`
	Status  string        `json:"status"`
	Done    bool          `json:"done"`
	Error   string        `json:"error,omitempty"`
	Expires string        `json:"expires,omitempty"`
}

type Store struct {
	Config Config `json:"config"`
	Tasks  []Task `json:"tasks"`
	Meta   Meta   `json:"meta"`
}

type NativeStore struct {
	Accounts []NativeAccount `json:"accounts"`
}

type Meta struct {
	StartedAt string `json:"startedAt"`
	PID       int    `json:"pid"`
	Version   string `json:"version"`
}

type App struct {
	mu         sync.Mutex
	dataDir    string
	storePath  string
	nativePath string
	startedAt  time.Time
	config     Config
	tasks      map[string]*Task
	native     map[string]*NativeAccount
	logins     map[string]*NativeLogin
	qrLogins   map[string]*NativeQRLogin
	running    map[string]chan struct{}
	nativeOps  map[string]*sync.Mutex
	nativeWait map[string]int64
	runtimes   map[string]*nativeRuntime
	client     *http.Client
}

type nativeRuntime struct {
	mu        sync.Mutex
	key       string
	signature string
	client    *telegram.Client
	ctx       context.Context
	cancel    context.CancelFunc
	ready     chan struct{}
	done      chan struct{}
	readyOnce sync.Once
	err       error
	primaryDC int
	invokers  map[int]telegram.CloseInvoker
	fileAPIs  map[int]*tg.Client
}

func main() {
	dataDir := env("FEIGRAM_DOWNLOADER_DATA", filepath.Join(env("DATA_DIR", "data"), "downloader"))
	port := env("FEIGRAM_DOWNLOADER_PORT", "3090")
	app := &App{
		dataDir:    dataDir,
		storePath:  filepath.Join(dataDir, "tasks.json"),
		nativePath: filepath.Join(dataDir, "native-sessions.json"),
		startedAt:  time.Now(),
		config: Config{
			Enabled:      true,
			Concurrency:  1,
			RateLimitBps: 0,
			Mode:         "conservative",
			PartSize:     defaultPartSize,
			Backend:      "go-sidecar",
			Transport:    "http-bridge",
			UpdatedAt:    now(),
		},
		tasks:      map[string]*Task{},
		native:     map[string]*NativeAccount{},
		logins:     map[string]*NativeLogin{},
		qrLogins:   map[string]*NativeQRLogin{},
		running:    map[string]chan struct{}{},
		nativeOps:  map[string]*sync.Mutex{},
		nativeWait: map[string]int64{},
		runtimes:   map[string]*nativeRuntime{},
		client: &http.Client{
			Timeout: 0,
			Transport: &http.Transport{
				Proxy:               http.ProxyFromEnvironment,
				MaxIdleConns:        32,
				MaxIdleConnsPerHost: 16,
				IdleConnTimeout:     90 * time.Second,
			},
		},
	}
	if err := app.load(); err != nil {
		log.Printf("load store: %v", err)
	}
	go app.pump()

	mux := http.NewServeMux()
	mux.HandleFunc("/health", app.handleHealth)
	mux.HandleFunc("/api/state", app.handleState)
	mux.HandleFunc("/api/config", app.handleConfig)
	mux.HandleFunc("/api/native/accounts", app.handleNativeAccounts)
	mux.HandleFunc("/api/native/accounts/", app.handleNativeAccount)
	mux.HandleFunc("/api/tasks", app.handleTasks)
	mux.HandleFunc("/api/tasks/", app.handleTask)

	server := &http.Server{
		Addr:              "127.0.0.1:" + port,
		Handler:           withJSON(mux),
		ReadHeaderTimeout: 5 * time.Second,
	}
	log.Printf("Feigram Downloader %s listening on %s", version, server.Addr)
	if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}
}

func (a *App) load() error {
	if err := os.MkdirAll(a.dataDir, 0o755); err != nil {
		return err
	}
	raw, err := os.ReadFile(a.storePath)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return a.saveLocked()
		}
		return err
	}
	var store Store
	if err := json.Unmarshal(raw, &store); err != nil {
		return err
	}
	if store.Config.Concurrency > 0 {
		a.config = sanitizeConfig(store.Config)
	}
	for i := range store.Tasks {
		task := store.Tasks[i]
		if task.ID == "" {
			task.ID = taskID(task.UserID, task.AccountID, task.PeerID, task.MessageID)
		}
		if task.Status == "downloading" || task.Status == "running" {
			task.Status = "queued"
			task.SpeedBps = 0
			task.Error = "Go 下载服务重启，已等待续传"
		}
		if task.Status == "error" && strings.Contains(task.Error, "session 未就绪") && task.SourceURL != "" {
			task.Status = "queued"
			task.Transport = "http-bridge"
			task.RetryAfter = 0
			task.Error = "升级后已自动切换 HTTP 回退并等待续传"
		}
		if task.Status == "error" && recoverableNativeTaskError(errors.New(task.Error)) {
			task.Status = "queued"
			task.SpeedBps = 0
			task.RetryAfter = 0
			task.Error = "升级后已修复同账号并发，正在等待断点续传"
		}
		if task.Status != "downloading" && task.Status != "running" {
			task.SpeedBps = 0
		}
		a.tasks[task.ID] = &task
	}
	if err := a.loadNativeLocked(); err != nil {
		log.Printf("load native sessions: %v", err)
	}
	if migrated := a.reconcileReadyLegacyTasksLocked(); migrated > 0 {
		log.Printf("startup promoted %d legacy HTTP tasks to native MTProto", migrated)
		return a.saveLocked()
	}
	return nil
}

func (a *App) loadNativeLocked() error {
	raw, err := os.ReadFile(a.nativePath)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return a.saveNativeLocked()
		}
		return err
	}
	var store NativeStore
	if err := json.Unmarshal(raw, &store); err != nil {
		return err
	}
	for i := range store.Accounts {
		account := store.Accounts[i]
		if account.UserID == "" || account.AccountID == "" {
			continue
		}
		account.Status = normalizeNativeStatus(account.Status, account.Ready)
		a.native[nativeAccountKey(account.UserID, account.AccountID)] = &account
	}
	return nil
}

func (a *App) saveLocked() error {
	tasks := a.listTasksLocked()
	store := Store{
		Config: a.config,
		Tasks:  tasks,
		Meta: Meta{
			StartedAt: a.startedAt.Format(time.RFC3339),
			PID:       os.Getpid(),
			Version:   version,
		},
	}
	raw, err := json.MarshalIndent(store, "", "  ")
	if err != nil {
		return err
	}
	tmp := a.storePath + ".tmp"
	if err := os.WriteFile(tmp, raw, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, a.storePath)
}

func (a *App) saveNativeLocked() error {
	accounts := make([]NativeAccount, 0, len(a.native))
	for _, account := range a.native {
		copy := *account
		accounts = append(accounts, copy)
	}
	sort.SliceStable(accounts, func(i, j int) bool {
		if accounts[i].UserID != accounts[j].UserID {
			return accounts[i].UserID < accounts[j].UserID
		}
		return accounts[i].AccountID < accounts[j].AccountID
	})
	raw, err := json.MarshalIndent(NativeStore{Accounts: accounts}, "", "  ")
	if err != nil {
		return err
	}
	tmp := a.nativePath + ".tmp"
	if err := os.WriteFile(tmp, raw, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, a.nativePath)
}

func (a *App) pump() {
	for {
		started := a.pumpOnce()
		if !started {
			time.Sleep(800 * time.Millisecond)
		}
	}
}

func (a *App) pumpOnce() bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	if !a.config.Enabled {
		return false
	}
	migrated := a.reconcileReadyLegacyTasksLocked()
	limit := a.config.Concurrency
	if a.config.Mode != "fast" {
		limit = 1
	}
	if limit < 1 {
		limit = 1
	}
	started := false
	nowUnix := time.Now().Unix()
	for _, task := range a.listTasksLocked() {
		if len(a.running) >= limit {
			break
		}
		if task.Status != "queued" {
			continue
		}
		if task.FilePath == "" {
			continue
		}
		transport := a.taskTransport(task)
		if transport == "http-bridge" && task.SourceURL == "" {
			continue
		}
		if task.RetryAfter > nowUnix {
			continue
		}
		if a.taskTransport(task) == "native-mtproto" && a.nativeWait[nativeAccountKey(task.UserID, task.AccountID)] > nowUnix {
			continue
		}
		if _, ok := a.running[task.ID]; ok {
			continue
		}
		if a.taskTransport(task) == "native-mtproto" && a.nativeAccountRunningLocked(task) {
			continue
		}
		cancel := make(chan struct{})
		a.running[task.ID] = cancel
		task.Status = "downloading"
		task.Error = ""
		task.UpdatedAt = now()
		started = true
		go a.runTask(task.ID, cancel)
	}
	if started || migrated > 0 {
		_ = a.saveLocked()
	}
	return started
}

func (a *App) runTask(id string, cancel <-chan struct{}) {
	defer func() {
		a.mu.Lock()
		delete(a.running, id)
		_ = a.saveLocked()
		a.mu.Unlock()
	}()

	for {
		task := a.taskSnapshot(id)
		if task == nil {
			return
		}
		if err := a.download(task, cancel); err != nil {
			if errors.Is(err, errCancelled) {
				a.updateTask(id, func(t *Task) {
					t.Status = "cancelled"
					t.SpeedBps = 0
					t.Error = ""
					t.RetryAfter = 0
					t.UpdatedAt = now()
				})
				return
			}
			if sourceAuthenticationError(err) && a.promoteTaskToNativeIfReady(id) {
				log.Printf("task %s HTTP source authorization expired; switched to native MTProto and resumed", id)
				continue
			}
			if transientSourceError(err) {
				delay := retryDelay(task.RetryCount + 1)
				if telegramDelay := floodWaitDelay(err); telegramDelay > 0 {
					delay = telegramDelay
					a.setNativeAccountWait(task.UserID, task.AccountID, time.Now().Add(delay))
				}
				a.updateTask(id, func(t *Task) {
					t.Status = "queued"
					t.SpeedBps = 0
					t.RetryCount++
					t.RetryAfter = time.Now().Add(delay).Unix()
					t.Error = fmt.Sprintf("媒体源暂不可用，%s 后自动续传：%s", formatDuration(delay), compactError(err))
					t.UpdatedAt = now()
				})
				log.Printf("task %s transient failure, retry in %s: %v", id, delay, err)
				return
			}
			a.updateTask(id, func(t *Task) {
				t.Status = "error"
				t.SpeedBps = 0
				t.Error = err.Error()
				t.RetryAfter = 0
				t.UpdatedAt = now()
			})
			log.Printf("task %s failed: %v", id, err)
			return
		}
		a.updateTask(id, func(t *Task) {
			t.Status = "completed"
			if stat, err := os.Stat(t.FilePath); err == nil {
				t.Downloaded = stat.Size()
				if t.Size <= 0 || stat.Size() > t.Size {
					t.Size = stat.Size()
				}
			}
			t.SpeedBps = 0
			t.Error = ""
			t.RetryCount = 0
			t.RetryAfter = 0
			t.UpdatedAt = now()
		})
		return
	}
}

var errCancelled = errors.New("cancelled")

func (a *App) download(task *Task, cancel <-chan struct{}) error {
	switch a.taskTransport(*task) {
	case "native-mtproto":
		account, err := a.nativeAccountSnapshot(task.UserID, task.AccountID)
		if err != nil || !nativeAccountEligible(account) {
			if task.SourceURL != "" {
				a.updateTask(task.ID, func(t *Task) {
					t.Transport = "http-bridge"
					t.Error = "Go 原生账号检查未通过，已自动切换 HTTP 回退"
					t.UpdatedAt = now()
				})
				task.Transport = "http-bridge"
				log.Printf("task %s native account unavailable, fallback to HTTP bridge", task.ID)
				return a.downloadHTTPBridge(task, cancel)
			}
		}
		return a.downloadNativeMTProto(task, cancel)
	default:
		return a.downloadHTTPBridge(task, cancel)
	}
}

func (a *App) downloadHTTPBridge(task *Task, cancel <-chan struct{}) error {
	if err := os.MkdirAll(filepath.Dir(task.FilePath), 0o755); err != nil {
		return err
	}
	if task.SourceURL == "" {
		return errors.New("HTTP 桥接媒体源为空，无法开始下载")
	}
	if task.PartPath == "" {
		task.PartPath = task.FilePath + ".part"
	}
	if stat, err := os.Stat(task.FilePath); err == nil && complete(stat.Size(), task.Size) {
		return nil
	}
	downloaded := int64(0)
	if stat, err := os.Stat(task.PartPath); err == nil {
		downloaded = stat.Size()
	}
	if task.Size > 0 && downloaded > task.Size {
		_ = os.Remove(task.PartPath)
		downloaded = 0
	}

	req, err := http.NewRequest(http.MethodGet, task.SourceURL, nil)
	if err != nil {
		return err
	}
	if downloaded > 0 {
		req.Header.Set("Range", fmt.Sprintf("bytes=%d-", downloaded))
	}
	resp, err := a.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusOK && downloaded > 0 {
		_ = os.Remove(task.PartPath)
		downloaded = 0
	}
	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusPartialContent {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return fmt.Errorf("source returned %d: %s", resp.StatusCode, strings.TrimSpace(string(body)))
	}
	if task.Size <= 0 && resp.ContentLength > 0 {
		task.Size = downloaded + resp.ContentLength
	}
	file, err := os.OpenFile(task.PartPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return err
	}
	defer file.Close()

	buffer := make([]byte, 128*1024)
	lastBytes := downloaded
	lastTick := time.Now()
	windowStart := time.Now()
	var windowBytes int64
	a.updateTask(task.ID, func(t *Task) {
		t.Downloaded = downloaded
		t.Size = max64(t.Size, task.Size)
		t.UpdatedAt = now()
	})
	for {
		select {
		case <-cancel:
			return errCancelled
		default:
		}
		n, readErr := resp.Body.Read(buffer)
		if n > 0 {
			if _, err := file.Write(buffer[:n]); err != nil {
				return err
			}
			downloaded += int64(n)
			windowBytes += int64(n)
			if err := a.throttle(windowBytes, windowStart, cancel); err != nil {
				return err
			}
			if a.config.RateLimitBps > 0 && time.Since(windowStart) >= time.Second {
				windowStart = time.Now()
				windowBytes = 0
			}
			if time.Since(lastTick) >= time.Second {
				elapsed := time.Since(lastTick).Seconds()
				speed := int64(float64(downloaded-lastBytes) / maxFloat(elapsed, 0.001))
				lastBytes = downloaded
				lastTick = time.Now()
				a.updateTask(task.ID, func(t *Task) {
					t.Downloaded = downloaded
					t.SpeedBps = speed
					t.Size = max64(t.Size, task.Size)
					t.UpdatedAt = now()
				})
			}
		}
		if readErr != nil {
			if errors.Is(readErr, io.EOF) {
				break
			}
			return readErr
		}
	}
	if err := file.Close(); err != nil {
		return err
	}
	stat, err := os.Stat(task.PartPath)
	if err != nil {
		return err
	}
	size := max64(task.Size, stat.Size())
	if !complete(stat.Size(), size) {
		return fmt.Errorf("file incomplete: %d / %d", stat.Size(), size)
	}
	if err := os.Rename(task.PartPath, task.FilePath); err != nil {
		return err
	}
	return nil
}

func (a *App) downloadNativeMTProto(task *Task, cancel <-chan struct{}) error {
	select {
	case <-cancel:
		return errCancelled
	default:
	}
	if task.PartPath == "" {
		task.PartPath = task.FilePath + ".part"
	}
	account, err := a.nativeAccountSnapshot(task.UserID, task.AccountID)
	if err != nil {
		return err
	}
	if !account.Ready || account.Session == "" {
		return fmt.Errorf("Go 原生 MTProto session 未就绪，请先在管理后台完成 Go 重新登录和健康检查")
	}
	opMu := a.nativeAccountOperationMutex(task.UserID, task.AccountID)
	opMu.Lock()
	defer opMu.Unlock()
	apiHash, err := a.nativeAPIHash(account)
	if err != nil {
		return err
	}
	if account.APIID <= 0 || apiHash == "" {
		return fmt.Errorf("Go 原生 MTProto 缺少 API ID/Hash，请重新同步服务端设置")
	}
	if err := os.MkdirAll(filepath.Dir(task.FilePath), 0o755); err != nil {
		return err
	}
	if stat, err := os.Stat(task.FilePath); err == nil && complete(stat.Size(), task.Size) {
		return nil
	}
	downloaded := int64(0)
	if stat, err := os.Stat(task.PartPath); err == nil {
		downloaded = stat.Size()
	}
	if task.Size > 0 && downloaded > task.Size {
		_ = os.Remove(task.PartPath)
		downloaded = 0
	}
	file, err := os.OpenFile(task.PartPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return err
	}
	defer file.Close()

	ctx, stop := context.WithCancel(context.Background())
	defer stop()
	go func() {
		select {
		case <-cancel:
			stop()
		case <-ctx.Done():
		}
	}()
	runtime, err := a.acquireNativeRuntime(ctx, account, apiHash)
	if err != nil {
		return classifyNativeReadError(err)
	}
	runErr := func(ctx context.Context) error {
		metadataAPI := runtime.api()
		if !nativeFileUsable(task.NativeFile) {
			refreshed, refreshErr := a.refreshNativeFileLocationFromTelegram(ctx, metadataAPI, *task)
			if refreshErr != nil {
				return fmt.Errorf("Go 原生任务缺少 file location，消息重取失败：%w", refreshErr)
			}
			task.NativeFile = refreshed
			log.Printf("task %s rebuilt native file location from Telegram message %d", task.ID, task.MessageID)
		}
		fileID, parseErr := strconv.ParseInt(task.NativeFile.FileID, 10, 64)
		if parseErr != nil {
			return fmt.Errorf("invalid native file id: %w", parseErr)
		}
		accessHash, parseErr := strconv.ParseInt(task.NativeFile.AccessHash, 10, 64)
		if parseErr != nil {
			return fmt.Errorf("invalid native access hash: %w", parseErr)
		}
		fileReference, parseErr := base64.StdEncoding.DecodeString(task.NativeFile.FileReference)
		if parseErr != nil {
			return fmt.Errorf("invalid native file reference: %w", parseErr)
		}
		var fileAPI *tg.Client
		fileDC := task.NativeFile.DCID
		switchToFileDC := func(dc int) error {
			if fileAPI != nil && fileDC == dc {
				return nil
			}
			api, err := runtime.fileAPI(dc)
			if err != nil {
				fileAPI = metadataAPI
				fileDC = 0
				return fmt.Errorf("connect Telegram file DC %d: %w", dc, err)
			}
			fileAPI = api
			fileDC = dc
			log.Printf("task %s reusing Telegram file pool for DC %d (primary DC %d)", task.ID, dc, runtime.primaryDC)
			return nil
		}
		if err := switchToFileDC(fileDC); err != nil {
			return classifyNativeReadError(err)
		}
		lastBytes := downloaded
		lastTick := time.Now()
		windowStart := time.Now()
		var windowBytes int64
		emptyReads := 0
		refreshedAfterEmpty := false
		a.updateTask(task.ID, func(t *Task) {
			t.Downloaded = downloaded
			t.Size = max64(t.Size, task.Size)
			t.UpdatedAt = now()
		})
		for {
			select {
			case <-ctx.Done():
				return errCancelled
			default:
			}
			if task.Size > 0 && downloaded >= task.Size {
				break
			}
			limit := int(a.currentPartSize())
			if limit <= 0 {
				limit = defaultPartSize
			}
			if task.Size > 0 && downloaded+int64(limit) > task.Size {
				limit = int(task.Size - downloaded)
			}
			location := &tg.InputDocumentFileLocation{
				ID:            fileID,
				AccessHash:    accessHash,
				FileReference: fileReference,
			}
			resp, err := fileAPI.UploadGetFile(ctx, &tg.UploadGetFileRequest{
				Precise:  true,
				Location: location,
				Offset:   downloaded,
				Limit:    limit,
			})
			if err != nil {
				if strings.Contains(err.Error(), "FILE_REFERENCE_EXPIRED") {
					refreshed, refreshErr := a.refreshNativeFileLocation(ctx, metadataAPI, task.ID)
					if refreshErr != nil {
						return fmt.Errorf("FILE_REFERENCE_EXPIRED: 自动刷新消息元数据失败：%w", refreshErr)
					}
					fileID, err = strconv.ParseInt(refreshed.FileID, 10, 64)
					if err != nil {
						return fmt.Errorf("invalid refreshed native file id: %w", err)
					}
					accessHash, err = strconv.ParseInt(refreshed.AccessHash, 10, 64)
					if err != nil {
						return fmt.Errorf("invalid refreshed native access hash: %w", err)
					}
					fileReference, err = base64.StdEncoding.DecodeString(refreshed.FileReference)
					if err != nil {
						return fmt.Errorf("invalid refreshed native file reference: %w", err)
					}
					task.NativeFile = refreshed
					if refreshed.DCID > 0 && refreshed.DCID != fileDC {
						if err := switchToFileDC(refreshed.DCID); err != nil {
							return classifyNativeReadError(err)
						}
					}
					log.Printf("task %s refreshed FILE_REFERENCE via Go message refetch and resumed at %d", task.ID, downloaded)
					continue
				}
				if migrateDC := migrationDC(err); migrateDC > 0 {
					log.Printf("task %s got Telegram DC migration request to %d at offset %d: %v", task.ID, migrateDC, downloaded, err)
					if err := switchToFileDC(migrateDC); err != nil {
						return classifyNativeReadError(err)
					}
					continue
				}
				return classifyNativeReadError(err)
			}
			chunk, ok := resp.(*tg.UploadFile)
			if !ok {
				return fmt.Errorf("Go 原生 MTProto 暂不支持 CDN redirect 响应：%T", resp)
			}
			if len(chunk.Bytes) == 0 {
				if task.Size <= 0 || downloaded >= task.Size {
					break
				}
				emptyReads++
				if emptyReads == 3 && !refreshedAfterEmpty {
					refreshed, refreshErr := a.refreshNativeFileLocationFromTelegram(ctx, metadataAPI, *task)
					if refreshErr == nil {
						fileID, err = strconv.ParseInt(refreshed.FileID, 10, 64)
						if err != nil {
							return fmt.Errorf("invalid empty-retry file id: %w", err)
						}
						accessHash, err = strconv.ParseInt(refreshed.AccessHash, 10, 64)
						if err != nil {
							return fmt.Errorf("invalid empty-retry access hash: %w", err)
						}
						fileReference, err = base64.StdEncoding.DecodeString(refreshed.FileReference)
						if err != nil {
							return fmt.Errorf("invalid empty-retry file reference: %w", err)
						}
						task.NativeFile = refreshed
						refreshedAfterEmpty = true
						if refreshed.DCID > 0 && refreshed.DCID != fileDC {
							if err := switchToFileDC(refreshed.DCID); err != nil {
								return classifyNativeReadError(err)
							}
						}
						log.Printf("task %s refreshed file location after empty chunk at offset %d", task.ID, downloaded)
					} else {
						log.Printf("task %s could not refresh after empty chunk at offset %d: %v", task.ID, downloaded, refreshErr)
					}
				}
				if emptyReads >= 6 {
					return fmt.Errorf("empty file chunk at offset %d after %d retries", downloaded, emptyReads)
				}
				wait := time.Duration(emptyReads) * time.Second
				timer := time.NewTimer(wait)
				select {
				case <-ctx.Done():
					timer.Stop()
					return errCancelled
				case <-timer.C:
				}
				continue
			}
			emptyReads = 0
			refreshedAfterEmpty = false
			if _, err := file.Write(chunk.Bytes); err != nil {
				return err
			}
			downloaded += int64(len(chunk.Bytes))
			windowBytes += int64(len(chunk.Bytes))
			if err := a.throttle(windowBytes, windowStart, cancel); err != nil {
				return err
			}
			if a.config.RateLimitBps > 0 && time.Since(windowStart) >= time.Second {
				windowStart = time.Now()
				windowBytes = 0
			}
			if time.Since(lastTick) >= time.Second {
				elapsed := time.Since(lastTick).Seconds()
				speed := int64(float64(downloaded-lastBytes) / maxFloat(elapsed, 0.001))
				lastBytes = downloaded
				lastTick = time.Now()
				a.updateTask(task.ID, func(t *Task) {
					t.Downloaded = downloaded
					t.SpeedBps = speed
					t.Size = max64(t.Size, task.Size)
					t.UpdatedAt = now()
				})
			}
		}
		return nil
	}(ctx)
	if runErr != nil {
		if nativeRuntimeBroken(runErr) {
			a.invalidateNativeRuntime(task.UserID, task.AccountID)
		}
		return runErr
	}
	if err := file.Close(); err != nil {
		return err
	}
	stat, err := os.Stat(task.PartPath)
	if err != nil {
		return err
	}
	size := max64(task.Size, stat.Size())
	if !complete(stat.Size(), size) {
		return fmt.Errorf("file incomplete: %d / %d", stat.Size(), size)
	}
	return os.Rename(task.PartPath, task.FilePath)
}

func (a *App) refreshNativeFileLocation(ctx context.Context, api *tg.Client, taskID string) (NativeFileLocation, error) {
	task := a.taskSnapshot(taskID)
	if task == nil {
		return NativeFileLocation{}, errors.New("task not found")
	}
	if refreshed, err := a.refreshNativeFileLocationFromTelegram(ctx, api, *task); err == nil {
		return refreshed, nil
	} else {
		log.Printf("task %s Go metadata refetch failed, fallback to Node metadata bridge: %v", taskID, err)
	}
	return a.refreshNativeFileLocationFromMetadataURL(taskID)
}

func (a *App) refreshNativeFileLocationFromTelegram(ctx context.Context, api *tg.Client, task Task) (NativeFileLocation, error) {
	if api == nil {
		return NativeFileLocation{}, errors.New("native api is nil")
	}
	messageID := int(task.MessageID)
	if messageID <= 0 {
		return NativeFileLocation{}, errors.New("native task missing message id")
	}
	reqCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	var result tg.MessagesMessagesClass
	var err error
	peerType := strings.ToLower(strings.TrimSpace(task.NativePeer.Type))
	switch peerType {
	case "channel":
		channelID, parseErr := strconv.ParseInt(task.NativePeer.ID, 10, 64)
		if parseErr != nil || channelID == 0 {
			return NativeFileLocation{}, fmt.Errorf("invalid native channel id: %w", parseErr)
		}
		accessHash, parseErr := strconv.ParseInt(task.NativePeer.AccessHash, 10, 64)
		if parseErr != nil {
			return NativeFileLocation{}, fmt.Errorf("invalid native channel access hash: %w", parseErr)
		}
		result, err = api.ChannelsGetMessages(reqCtx, &tg.ChannelsGetMessagesRequest{
			Channel: &tg.InputChannel{ChannelID: channelID, AccessHash: accessHash},
			ID:      []tg.InputMessageClass{&tg.InputMessageID{ID: messageID}},
		})
	case "user", "chat":
		result, err = api.MessagesGetMessages(reqCtx, []tg.InputMessageClass{&tg.InputMessageID{ID: messageID}})
	default:
		return NativeFileLocation{}, errors.New("native peer metadata missing; old task requires Node metadata fallback")
	}
	if err != nil {
		return NativeFileLocation{}, classifyNativeReadError(err)
	}
	doc, err := nativeDocumentFromMessages(result, messageID)
	if err != nil && (peerType == "user" || peerType == "chat") {
		peer, peerErr := nativeInputPeer(task.NativePeer)
		if peerErr == nil {
			history, historyErr := api.MessagesGetHistory(reqCtx, &tg.MessagesGetHistoryRequest{
				Peer:     peer,
				OffsetID: messageID + 1,
				Limit:    3,
			})
			if historyErr == nil {
				doc, err = nativeDocumentFromMessages(history, messageID)
			} else {
				err = classifyNativeReadError(historyErr)
			}
		}
	}
	if err != nil {
		return NativeFileLocation{}, err
	}
	refreshed := NativeFileLocation{
		PeerID:        task.PeerID,
		MessageID:     task.MessageID,
		Kind:          coalesce(task.NativeFile.Kind, task.Kind),
		FileID:        strconv.FormatInt(doc.ID, 10),
		AccessHash:    strconv.FormatInt(doc.AccessHash, 10),
		FileReference: base64.StdEncoding.EncodeToString(doc.FileReference),
		DCID:          doc.DCID,
		Size:          max64(doc.Size, task.Size),
		MimeType:      coalesce(task.NativeFile.MimeType, coalesce(task.ContentType, doc.MimeType)),
		FileName:      coalesce(task.NativeFile.FileName, task.FileName),
		UpdatedAt:     now(),
	}
	a.updateTask(task.ID, func(t *Task) {
		t.NativeFile = refreshed
		t.Error = ""
		t.UpdatedAt = now()
	})
	return refreshed, nil
}

func nativeInputPeer(peer NativePeerLocation) (tg.InputPeerClass, error) {
	id, err := strconv.ParseInt(peer.ID, 10, 64)
	if err != nil || id == 0 {
		return nil, fmt.Errorf("invalid native peer id: %w", err)
	}
	switch strings.ToLower(strings.TrimSpace(peer.Type)) {
	case "user":
		accessHash, parseErr := strconv.ParseInt(peer.AccessHash, 10, 64)
		if parseErr != nil {
			return nil, fmt.Errorf("invalid native user access hash: %w", parseErr)
		}
		return &tg.InputPeerUser{UserID: id, AccessHash: accessHash}, nil
	case "chat":
		return &tg.InputPeerChat{ChatID: id}, nil
	default:
		return nil, fmt.Errorf("unsupported native peer type %q", peer.Type)
	}
}

func nativeDocumentFromMessages(result tg.MessagesMessagesClass, messageID int) (*tg.Document, error) {
	modified, ok := result.AsModified()
	if !ok {
		return nil, fmt.Errorf("unexpected messages result: %T", result)
	}
	for _, item := range modified.GetMessages() {
		message, ok := item.(*tg.Message)
		if !ok || message.ID != messageID {
			continue
		}
		media, ok := message.GetMedia()
		if !ok {
			return nil, errors.New("消息已存在，但没有媒体文件")
		}
		docMedia, ok := media.(*tg.MessageMediaDocument)
		if !ok {
			return nil, fmt.Errorf("消息媒体不是文档视频：%T", media)
		}
		doc, ok := docMedia.Document.(*tg.Document)
		if !ok || doc == nil {
			return nil, fmt.Errorf("消息文档类型不支持：%T", docMedia.Document)
		}
		return doc, nil
	}
	return nil, errors.New("你要访问的内容已被删除，或当前账号没有权限读取这条消息")
}

func (a *App) refreshNativeFileLocationFromMetadataURL(taskID string) (NativeFileLocation, error) {
	task := a.taskSnapshot(taskID)
	if task == nil {
		return NativeFileLocation{}, errors.New("task not found")
	}
	if task.MetadataURL == "" {
		return NativeFileLocation{}, errors.New("metadata refresh url is empty")
	}
	req, err := http.NewRequest(http.MethodGet, task.MetadataURL, nil)
	if err != nil {
		return NativeFileLocation{}, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
	defer cancel()
	resp, err := a.client.Do(req.WithContext(ctx))
	if err != nil {
		return NativeFileLocation{}, err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 2*1024*1024))
	if resp.StatusCode != http.StatusOK {
		return NativeFileLocation{}, fmt.Errorf("metadata refresh returned %d: %s", resp.StatusCode, strings.TrimSpace(string(raw)))
	}
	var payload struct {
		NativeFile NativeFileLocation `json:"nativeFile"`
		NativePeer NativePeerLocation `json:"nativePeer"`
	}
	if err := json.Unmarshal(raw, &payload); err != nil {
		return NativeFileLocation{}, err
	}
	if payload.NativeFile.FileID == "" || payload.NativeFile.AccessHash == "" || payload.NativeFile.FileReference == "" {
		return NativeFileLocation{}, errors.New("refreshed metadata missing native file location")
	}
	a.updateTask(taskID, func(t *Task) {
		t.NativeFile = payload.NativeFile
		if payload.NativePeer.Type != "" || payload.NativePeer.ID != "" {
			t.NativePeer = payload.NativePeer
		}
		t.NativeFile.UpdatedAt = coalesce(t.NativeFile.UpdatedAt, now())
		t.Error = ""
		t.UpdatedAt = now()
	})
	return payload.NativeFile, nil
}

func (a *App) taskTransport(task Task) string {
	if task.Transport != "" {
		return normalizeTransport(task.Transport)
	}
	return normalizeTransport(a.config.Transport)
}

func (a *App) throttle(windowBytes int64, windowStart time.Time, cancel <-chan struct{}) error {
	limit := a.config.RateLimitBps
	if limit <= 0 {
		return nil
	}
	expected := time.Duration(float64(windowBytes) / float64(limit) * float64(time.Second))
	sleepFor := expected - time.Since(windowStart)
	if sleepFor <= 0 {
		return nil
	}
	timer := time.NewTimer(sleepFor)
	defer timer.Stop()
	select {
	case <-cancel:
		return errCancelled
	case <-timer.C:
		return nil
	}
}

func (a *App) taskSnapshot(id string) *Task {
	a.mu.Lock()
	defer a.mu.Unlock()
	task := a.tasks[id]
	if task == nil {
		return nil
	}
	copy := *task
	return &copy
}

func (a *App) updateTask(id string, update func(*Task)) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if task := a.tasks[id]; task != nil {
		update(task)
		_ = a.saveLocked()
	}
}

func (a *App) handleHealth(w http.ResponseWriter, _ *http.Request) {
	a.mu.Lock()
	defer a.mu.Unlock()
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":        true,
		"version":   version,
		"pid":       os.Getpid(),
		"uptime":    int(time.Since(a.startedAt).Seconds()),
		"taskCount": len(a.tasks),
		"running":   len(a.running),
		"config":    a.config,
	})
}

func (a *App) handleState(w http.ResponseWriter, _ *http.Request) {
	a.mu.Lock()
	defer a.mu.Unlock()
	writeJSON(w, http.StatusOK, a.stateLocked())
}

func (a *App) handleConfig(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPut && r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}
	var patch map[string]any
	if err := json.NewDecoder(r.Body).Decode(&patch); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	a.mu.Lock()
	a.config = sanitizeConfig(applyConfigPatch(a.config, patch))
	if a.config.Transport == "native-mtproto" && !a.nativeReadyLocked() {
		a.config.Transport = "http-bridge"
	}
	a.config.UpdatedAt = now()
	err := a.saveLocked()
	a.mu.Unlock()
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	go a.pumpOnce()
	writeJSON(w, http.StatusOK, a.snapshot())
}

func (a *App) handleTasks(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		a.mu.Lock()
		defer a.mu.Unlock()
		writeJSON(w, http.StatusOK, a.listTasksLocked())
	case http.MethodPost:
		var input Task
		if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
		a.mu.Lock()
		task := a.upsertTaskLocked(input)
		err := a.saveLocked()
		a.mu.Unlock()
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		go a.pumpOnce()
		writeJSON(w, http.StatusOK, task)
	default:
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
	}
}

func (a *App) handleNativeAccounts(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		a.mu.Lock()
		defer a.mu.Unlock()
		writeJSON(w, http.StatusOK, a.publicNativeAccountsLocked())
	case http.MethodPost, http.MethodPut:
		var input NativeAccount
		if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
		if input.UserID == "" || input.AccountID == "" {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "userId and accountId are required"})
			return
		}
		a.mu.Lock()
		account, err := a.upsertNativeAccountLocked(input)
		if err == nil {
			err = a.saveNativeLocked()
		}
		a.mu.Unlock()
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, publicNativeAccount(account))
	default:
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
	}
}

func (a *App) handleNativeAccount(w http.ResponseWriter, r *http.Request) {
	rest := strings.TrimPrefix(r.URL.Path, "/api/native/accounts/")
	parts := strings.Split(strings.Trim(rest, "/"), "/")
	if len(parts) < 2 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "expected /api/native/accounts/:userId/:accountId"})
		return
	}
	userID, err := url.PathUnescape(parts[0])
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	accountID, err := url.PathUnescape(parts[1])
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	action := ""
	if len(parts) >= 3 {
		action = parts[2]
	}
	a.mu.Lock()
	account := a.native[nativeAccountKey(userID, accountID)]
	if account == nil {
		a.mu.Unlock()
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "native account is not prepared"})
		return
	}
	switch {
	case r.Method == http.MethodGet && action == "":
		defer a.mu.Unlock()
		writeJSON(w, http.StatusOK, publicNativeAccount(*account))
	case r.Method == http.MethodPost && action == "health":
		snapshot := *account
		a.mu.Unlock()
		checked, err := a.nativeHealthCheck(snapshot)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, publicNativeAccount(checked))
	case r.Method == http.MethodPost && action == "login" && len(parts) >= 4 && parts[3] == "start":
		a.mu.Unlock()
		var input struct {
			Phone   string `json:"phone"`
			APIID   int    `json:"apiId"`
			APIHash string `json:"apiHash"`
		}
		if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
		result, err := a.startNativeLogin(userID, accountID, input.Phone, input.APIID, input.APIHash)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"loginId":          result.LoginID,
			"passwordRequired": result.PasswordRequired,
			"done":             result.Done,
			"account":          publicNativeAccount(result.Account),
		})
	case r.Method == http.MethodPost && action == "login" && len(parts) >= 4 && parts[3] == "qr-start":
		a.mu.Unlock()
		var input struct {
			APIID   int    `json:"apiId"`
			APIHash string `json:"apiHash"`
		}
		if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
		result, err := a.startNativeQRLogin(userID, accountID, input.APIID, input.APIHash)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, result)
	case r.Method == http.MethodPost && action == "login" && len(parts) >= 4 && parts[3] == "qr-status":
		a.mu.Unlock()
		var input struct {
			LoginID string `json:"loginId"`
		}
		if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
		result, err := a.pollNativeQRLogin(input.LoginID)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, result)
	case r.Method == http.MethodPost && action == "login" && len(parts) >= 4 && (parts[3] == "code" || parts[3] == "password"):
		a.mu.Unlock()
		var input struct {
			LoginID  string `json:"loginId"`
			Code     string `json:"code"`
			Password string `json:"password"`
		}
		if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
		result, err := a.continueNativeLogin(input.LoginID, parts[3], input.Code, input.Password)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"loginId":          result.LoginID,
			"passwordRequired": result.PasswordRequired,
			"done":             result.Done,
			"account":          publicNativeAccount(result.Account),
		})
	default:
		a.mu.Unlock()
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
	}
}

func (a *App) handleTask(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimPrefix(r.URL.Path, "/api/tasks/")
	action := ""
	if strings.Contains(id, "/") {
		parts := strings.SplitN(id, "/", 2)
		id, action = parts[0], parts[1]
	}
	a.mu.Lock()
	task, ok := a.tasks[id]
	if !ok {
		a.mu.Unlock()
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "task not found"})
		return
	}
	switch {
	case r.Method == http.MethodGet:
	case r.Method == http.MethodDelete:
		if cancel := a.running[id]; cancel != nil {
			close(cancel)
			delete(a.running, id)
		}
		delete(a.tasks, id)
	case r.Method == http.MethodPost && action == "cancel":
		if cancel := a.running[id]; cancel != nil {
			close(cancel)
			delete(a.running, id)
		}
		task.Status = "cancelled"
		task.SpeedBps = 0
		task.Error = ""
		task.RetryAfter = 0
		task.UpdatedAt = now()
	case r.Method == http.MethodPost && action == "queue":
		task.Status = "queued"
		task.SpeedBps = 0
		task.Error = ""
		task.RetryCount = 0
		task.RetryAfter = 0
		task.UpdatedAt = now()
	default:
		a.mu.Unlock()
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}
	err := a.saveLocked()
	result := *task
	a.mu.Unlock()
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	go a.pumpOnce()
	writeJSON(w, http.StatusOK, result)
}

func (a *App) snapshot() map[string]any {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.stateLocked()
}

func (a *App) stateLocked() map[string]any {
	tasks := a.listTasksLocked()
	counts := map[string]int{}
	var speed int64
	for _, task := range tasks {
		counts[task.Status]++
		if task.Status == "downloading" || task.Status == "running" {
			speed += task.SpeedBps
		}
	}
	transport := normalizeTransport(a.config.Transport)
	strategy := "Go 下载服务已接管队列、断点、限速和落盘；可在保守模式与 Go 原生 MTProto 模式之间切换，HTTP 桥接仍作为回退。"
	nativeReady := a.nativeReadyLocked()
	readyAccountKeys := make([]string, 0)
	for _, account := range a.native {
		if nativeAccountEligible(*account) {
			readyAccountKeys = append(readyAccountKeys, nativeAccountKey(account.UserID, account.AccountID))
		}
	}
	sort.Strings(readyAccountKeys)
	native := map[string]any{
		"ready":            nativeReady,
		"readyAccountKeys": readyAccountKeys,
		"requiredPasses":   2,
		"status":           "needs-login",
		"note":             "Go 原生 MTProto 需要扫码登录并连续通过 2 次真实 Telegram 文件健康检查。",
	}
	if nativeReady {
		native["status"] = "healthy"
		native["note"] = "已有健康 Go 原生 MTProto session，可以灰度启用 native-mtproto。"
	}
	if transport == "native-mtproto" {
		strategy = "Go 原生 MTProto 传输层已选择；文件读取会直接使用 Go session，FILE_REFERENCE_EXPIRED 会尝试刷新元数据后续传。"
	}
	return map[string]any{
		"ok":            true,
		"version":       version,
		"pid":           os.Getpid(),
		"uptime":        int(time.Since(a.startedAt).Seconds()),
		"dataDir":       a.dataDir,
		"config":        a.config,
		"counts":        counts,
		"running":       len(a.running),
		"speedBps":      speed,
		"tasks":         tasks,
		"transport":     transport,
		"nativeMTProto": native,
		"strategy":      strategy,
	}
}

func (a *App) listTasksLocked() []Task {
	tasks := make([]Task, 0, len(a.tasks))
	for _, task := range a.tasks {
		tasks = append(tasks, *task)
	}
	sort.SliceStable(tasks, func(i, j int) bool {
		if tasks[i].Order != tasks[j].Order {
			return tasks[i].Order < tasks[j].Order
		}
		return tasks[i].CreatedAt < tasks[j].CreatedAt
	})
	return tasks
}

func (a *App) upsertTaskLocked(input Task) Task {
	if input.ID == "" {
		input.ID = taskID(input.UserID, input.AccountID, input.PeerID, input.MessageID)
	}
	existing := a.tasks[input.ID]
	if existing == nil {
		created := now()
		input.CreatedAt = created
		input.UpdatedAt = created
		input.Status = coalesce(input.Status, "queued")
		input.Source = coalesce(input.Source, "manual")
		input.Order = input.OrderOrDefault(int64(len(a.tasks) + 1))
		if input.PartPath == "" && input.FilePath != "" {
			input.PartPath = input.FilePath + ".part"
		}
		a.tasks[input.ID] = &input
		return input
	}
	if input.FileName != "" {
		existing.FileName = input.FileName
	}
	if input.Size > 0 {
		existing.Size = input.Size
	}
	if input.ContentType != "" {
		existing.ContentType = input.ContentType
	}
	if input.Kind != "" {
		existing.Kind = input.Kind
	}
	if input.Source != "" {
		existing.Source = input.Source
	}
	if input.Transport != "" {
		existing.Transport = normalizeTransport(input.Transport)
	}
	existing.AutoCache = existing.AutoCache || input.AutoCache
	if input.SourceURL != "" {
		existing.SourceURL = input.SourceURL
	}
	if input.MetadataURL != "" {
		existing.MetadataURL = input.MetadataURL
	}
	if input.NativePeer.Type != "" || input.NativePeer.ID != "" {
		existing.NativePeer = input.NativePeer
	}
	if input.FilePath != "" {
		existing.FilePath = input.FilePath
	}
	if input.PartPath != "" {
		existing.PartPath = input.PartPath
	} else if existing.PartPath == "" && existing.FilePath != "" {
		existing.PartPath = existing.FilePath + ".part"
	}
	if input.InlineURL != "" {
		existing.InlineURL = input.InlineURL
	}
	if input.NativeFile.MessageID != 0 || input.NativeFile.FileID != "" || input.NativeFile.FileReference != "" {
		existing.NativeFile = input.NativeFile
		existing.NativeFile.UpdatedAt = coalesce(existing.NativeFile.UpdatedAt, now())
	}
	if input.Order > 0 {
		existing.Order = input.Order
	}
	if existing.Status == "cancelled" || existing.Status == "error" {
		existing.Status = "queued"
		existing.RetryCount = 0
		existing.RetryAfter = 0
	}
	existing.UpdatedAt = now()
	if existing.Status == "completed" {
		stat, statErr := os.Stat(existing.FilePath)
		if statErr != nil || !complete(stat.Size(), existing.Size) {
			existing.Status = "queued"
			existing.Error = "本地缓存文件不存在或不完整，已重新排队"
			existing.SpeedBps = 0
			existing.RetryAfter = 0
			if partStat, partErr := os.Stat(existing.PartPath); partErr == nil {
				existing.Downloaded = partStat.Size()
			} else {
				existing.Downloaded = 0
			}
		}
	}
	return *existing
}

func (a *App) upsertNativeAccountLocked(input NativeAccount) (NativeAccount, error) {
	key := nativeAccountKey(input.UserID, input.AccountID)
	existing := a.native[key]
	created := now()
	if existing == nil {
		existing = &NativeAccount{
			UserID:    input.UserID,
			AccountID: input.AccountID,
			Status:    "needs-relogin",
			CreatedAt: created,
		}
		a.native[key] = existing
	}
	if input.Phone != "" {
		existing.Phone = input.Phone
	}
	if input.DisplayName != "" {
		existing.DisplayName = input.DisplayName
	}
	if input.APIID > 0 {
		existing.APIID = input.APIID
	}
	if input.APIHash != "" {
		encrypted, err := a.encryptNativeSession([]byte(input.APIHash))
		if err != nil {
			return NativeAccount{}, err
		}
		existing.APIHash = encrypted
	}
	if input.Session != "" {
		encrypted, err := a.encryptNativeSession([]byte(input.Session))
		if err != nil {
			return NativeAccount{}, err
		}
		existing.Session = encrypted
		existing.Ready = false
		existing.HealthPasses = 0
		existing.Status = "session-imported"
		existing.Error = "Go session payload 已加密保存，等待 gotd 健康检查"
	}
	if input.Status != "" && !(input.Status == "needs-relogin" && existing.Session != "") {
		existing.Status = normalizeNativeStatus(input.Status, input.Ready)
	}
	if input.Ready {
		existing.Ready = true
		if existing.HealthPasses < 2 {
			existing.HealthPasses = 2
		}
		existing.Status = "healthy"
		existing.Error = ""
	}
	existing.UpdatedAt = now()
	return *existing, nil
}

func (a *App) publicNativeAccountsLocked() []map[string]any {
	accounts := make([]map[string]any, 0, len(a.native))
	for _, account := range a.native {
		accounts = append(accounts, publicNativeAccount(*account))
	}
	sort.SliceStable(accounts, func(i, j int) bool {
		left := fmt.Sprint(accounts[i]["userId"], "/", accounts[i]["accountId"])
		right := fmt.Sprint(accounts[j]["userId"], "/", accounts[j]["accountId"])
		return left < right
	})
	return accounts
}

func (a *App) nativeReadyLocked() bool {
	for _, account := range a.native {
		if nativeAccountEligible(*account) {
			return true
		}
	}
	return false
}

func nativeAccountEligible(account NativeAccount) bool {
	return account.Ready && account.HealthPasses >= 2 && account.Session != "" && account.APIID > 0 && account.APIHash != ""
}

func (t Task) OrderOrDefault(fallback int64) int64 {
	if t.Order > 0 {
		return t.Order
	}
	return fallback
}

func sanitizeConfig(input Config) Config {
	if input.Concurrency < 1 {
		input.Concurrency = 1
	}
	if input.Concurrency > 10 {
		input.Concurrency = 10
	}
	if input.RateLimitBps < 0 {
		input.RateLimitBps = 0
	}
	if input.PartSize <= 0 {
		input.PartSize = defaultPartSize
	}
	if input.Mode != "fast" {
		input.Mode = "conservative"
	}
	if input.Backend == "" {
		input.Backend = "go-sidecar"
	}
	input.Transport = normalizeTransport(input.Transport)
	if input.UpdatedAt == "" {
		input.UpdatedAt = now()
	}
	return input
}

func applyConfigPatch(current Config, patch map[string]any) Config {
	if value, ok := boolValue(patch["enabled"]); ok {
		current.Enabled = value
	}
	if value, ok := intValue(patch["concurrency"]); ok {
		current.Concurrency = value
	}
	if value, ok := int64Value(patch["rateLimitBps"]); ok {
		current.RateLimitBps = value
	}
	if value, ok := stringValue(patch["mode"]); ok {
		current.Mode = value
	}
	if value, ok := int64Value(patch["partSize"]); ok {
		current.PartSize = value
	}
	if value, ok := stringValue(patch["transport"]); ok {
		current.Transport = value
	}
	return current
}

func normalizeTransport(value string) string {
	switch strings.TrimSpace(strings.ToLower(value)) {
	case "native-mtproto", "go-mtproto", "gotd", "tdl":
		return "native-mtproto"
	default:
		return "http-bridge"
	}
}

func publicNativeAccount(account NativeAccount) map[string]any {
	return map[string]any{
		"userId":               account.UserID,
		"accountId":            account.AccountID,
		"phone":                account.Phone,
		"displayName":          account.DisplayName,
		"apiId":                account.APIID,
		"apiSet":               account.APIID > 0 && account.APIHash != "",
		"status":               normalizeNativeStatus(account.Status, account.Ready),
		"ready":                nativeAccountEligible(account),
		"sessionSet":           account.Session != "",
		"error":                account.Error,
		"healthPasses":         account.HealthPasses,
		"lastHealthBytes":      account.LastHealthBytes,
		"lastHealthDc":         account.LastHealthDC,
		"lastHealthDurationMs": account.LastHealthDurationMS,
		"createdAt":            account.CreatedAt,
		"updatedAt":            account.UpdatedAt,
		"checkedAt":            account.CheckedAt,
	}
}

func normalizeNativeStatus(status string, ready bool) string {
	if ready {
		return "healthy"
	}
	switch strings.TrimSpace(status) {
	case "healthy", "session-imported", "needs-relogin", "code-sent", "password-needed", "qr-waiting", "checking", "failed":
		return status
	default:
		return "needs-relogin"
	}
}

func nativeAccountKey(userID, accountID string) string {
	return userID + "|" + accountID
}

func (a *App) encryptNativeSession(plain []byte) (string, error) {
	key, err := a.nativeSecretKey()
	if err != nil {
		return "", err
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return "", err
	}
	cipherText := gcm.Seal(nil, nonce, plain, nil)
	return "v1:" + base64.StdEncoding.EncodeToString(nonce) + ":" + base64.StdEncoding.EncodeToString(cipherText), nil
}

func (a *App) decryptNativeSession(encoded string) ([]byte, error) {
	if strings.TrimSpace(encoded) == "" {
		return nil, session.ErrNotFound
	}
	parts := strings.Split(encoded, ":")
	if len(parts) != 3 || parts[0] != "v1" {
		return nil, errors.New("unsupported encrypted native payload")
	}
	key, err := a.nativeSecretKey()
	if err != nil {
		return nil, err
	}
	nonce, err := base64.StdEncoding.DecodeString(parts[1])
	if err != nil {
		return nil, err
	}
	cipherText, err := base64.StdEncoding.DecodeString(parts[2])
	if err != nil {
		return nil, err
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	return gcm.Open(nil, nonce, cipherText, nil)
}

func (a *App) nativeAPIHash(account NativeAccount) (string, error) {
	if account.APIHash == "" {
		return "", nil
	}
	plain, err := a.decryptNativeSession(account.APIHash)
	if err != nil {
		return "", err
	}
	return string(plain), nil
}

type nativeSessionStorage struct {
	app       *App
	userID    string
	accountID string
}

func (s nativeSessionStorage) LoadSession(ctx context.Context) ([]byte, error) {
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	default:
	}
	s.app.mu.Lock()
	account := s.app.native[nativeAccountKey(s.userID, s.accountID)]
	encoded := ""
	if account != nil {
		encoded = account.Session
	}
	s.app.mu.Unlock()
	if encoded == "" {
		return nil, session.ErrNotFound
	}
	return s.app.decryptNativeSession(encoded)
}

func (s nativeSessionStorage) StoreSession(ctx context.Context, data []byte) error {
	select {
	case <-ctx.Done():
		return ctx.Err()
	default:
	}
	encrypted, err := s.app.encryptNativeSession(data)
	if err != nil {
		return err
	}
	s.app.mu.Lock()
	defer s.app.mu.Unlock()
	account := s.app.native[nativeAccountKey(s.userID, s.accountID)]
	if account == nil {
		account = &NativeAccount{
			UserID:    s.userID,
			AccountID: s.accountID,
			Status:    "session-imported",
			CreatedAt: now(),
		}
		s.app.native[nativeAccountKey(s.userID, s.accountID)] = account
	}
	account.Session = encrypted
	account.UpdatedAt = now()
	if account.Status == "" || account.Status == "needs-relogin" {
		account.Status = "session-imported"
	}
	return s.app.saveNativeLocked()
}

func (a *App) nativeAccountSnapshot(userID, accountID string) (NativeAccount, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.nativeAccountSnapshotLocked(userID, accountID)
}

func (a *App) nativeAccountSnapshotLocked(userID, accountID string) (NativeAccount, error) {
	account := a.native[nativeAccountKey(userID, accountID)]
	if account == nil {
		return NativeAccount{}, fmt.Errorf("Go 原生 MTProto 账号未准备好")
	}
	return *account, nil
}

func (a *App) newTelegramClient(account NativeAccount, apiHash string) (*telegram.Client, error) {
	if account.APIID <= 0 || apiHash == "" {
		return nil, errors.New("Go 原生 MTProto 缺少 API ID/Hash")
	}
	options := telegram.Options{
		SessionStorage:   nativeSessionStorage{app: a, userID: account.UserID, accountID: account.AccountID},
		NoUpdates:        true,
		MigrationTimeout: 30 * time.Second,
		RetryInterval:    time.Second,
		MaxRetries:       5,
	}
	if account.Session == "" {
		options.SessionStorage = nativeSessionStorage{app: a, userID: account.UserID, accountID: account.AccountID}
	}
	return telegram.NewClient(account.APIID, apiHash, options), nil
}

func nativeRuntimeSignature(account NativeAccount) string {
	sum := sha256.Sum256([]byte(fmt.Sprintf("%d|%s|%s", account.APIID, account.APIHash, account.Session)))
	return hex.EncodeToString(sum[:])
}

func (a *App) acquireNativeRuntime(ctx context.Context, account NativeAccount, apiHash string) (*nativeRuntime, error) {
	key := nativeAccountKey(account.UserID, account.AccountID)
	signature := nativeRuntimeSignature(account)
	primaryDC := a.nativePrimaryDC(ctx, account)

	a.mu.Lock()
	runtime := a.runtimes[key]
	if runtime != nil && runtime.signature != signature {
		runtime.cancel()
		runtime = nil
	}
	if runtime != nil {
		select {
		case <-runtime.done:
			runtime = nil
		default:
		}
	}
	if runtime == nil {
		client, err := a.newTelegramClient(account, apiHash)
		if err != nil {
			a.mu.Unlock()
			return nil, err
		}
		runtimeCtx, cancel := context.WithCancel(context.Background())
		runtime = &nativeRuntime{
			key:       key,
			signature: signature,
			client:    client,
			ctx:       runtimeCtx,
			cancel:    cancel,
			ready:     make(chan struct{}),
			done:      make(chan struct{}),
			primaryDC: primaryDC,
			invokers:  map[int]telegram.CloseInvoker{},
			fileAPIs:  map[int]*tg.Client{},
		}
		a.runtimes[key] = runtime
		go a.runNativeRuntime(runtime)
	}
	a.mu.Unlock()

	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-runtime.done:
		runtime.mu.Lock()
		err := runtime.err
		runtime.mu.Unlock()
		if err == nil {
			err = errors.New("Telegram MTProto engine was closed")
		}
		return nil, err
	case <-runtime.ready:
	}

	select {
	case <-runtime.done:
		runtime.mu.Lock()
		err := runtime.err
		runtime.mu.Unlock()
		if err == nil {
			err = errors.New("Telegram MTProto engine was closed")
		}
		return nil, err
	default:
		return runtime, nil
	}
}

func (a *App) runNativeRuntime(runtime *nativeRuntime) {
	err := runtime.client.Run(runtime.ctx, func(runCtx context.Context) error {
		runtime.mu.Lock()
		runtime.ctx = runCtx
		runtime.mu.Unlock()
		runtime.readyOnce.Do(func() { close(runtime.ready) })
		<-runCtx.Done()
		return nil
	})

	runtime.mu.Lock()
	for dc, invoker := range runtime.invokers {
		if closeErr := invoker.Close(); closeErr != nil {
			log.Printf("native runtime %s close DC %d pool: %v", runtime.key, dc, closeErr)
		}
	}
	runtime.invokers = map[int]telegram.CloseInvoker{}
	runtime.fileAPIs = map[int]*tg.Client{}
	runtime.err = err
	runtime.mu.Unlock()
	runtime.readyOnce.Do(func() { close(runtime.ready) })
	close(runtime.done)
	if err != nil && !errors.Is(err, context.Canceled) {
		log.Printf("native runtime %s stopped: %v", runtime.key, err)
	}
}

func (a *App) invalidateNativeRuntime(userID, accountID string) {
	key := nativeAccountKey(userID, accountID)
	a.mu.Lock()
	runtime := a.runtimes[key]
	delete(a.runtimes, key)
	a.mu.Unlock()
	if runtime != nil {
		runtime.cancel()
	}
}

func (runtime *nativeRuntime) api() *tg.Client {
	return runtime.client.API()
}

func (runtime *nativeRuntime) fileAPI(dc int) (*tg.Client, error) {
	runtime.mu.Lock()
	defer runtime.mu.Unlock()
	select {
	case <-runtime.done:
		if runtime.err != nil {
			return nil, runtime.err
		}
		return nil, errors.New("Telegram MTProto engine was closed")
	default:
	}
	if api := runtime.fileAPIs[dc]; api != nil {
		return api, nil
	}
	invoker, err := nativeFilePool(runtime.ctx, runtime.client, dc, runtime.primaryDC, 1)
	if err != nil {
		return nil, err
	}
	runtime.invokers[dc] = invoker
	api := tg.NewClient(invoker)
	runtime.fileAPIs[dc] = api
	return api, nil
}

func (a *App) nativePrimaryDC(ctx context.Context, account NativeAccount) int {
	loader := session.Loader{Storage: nativeSessionStorage{app: a, userID: account.UserID, accountID: account.AccountID}}
	data, err := loader.Load(ctx)
	if err != nil || data == nil {
		return 0
	}
	if data.DC > 0 {
		return data.DC
	}
	return data.Config.ThisDC
}

func nativeFilePool(ctx context.Context, client *telegram.Client, dc, primaryDC int, max int64) (telegram.CloseInvoker, error) {
	if dc <= 0 || dc == primaryDC {
		invoker, err := client.Pool(max)
		if err != nil {
			return nil, fmt.Errorf("create primary DC %d file pool: %w", primaryDC, err)
		}
		return invoker, nil
	}
	invoker, err := client.DC(ctx, dc, max)
	if err != nil {
		return nil, fmt.Errorf("create DC %d file pool from primary DC %d: %w", dc, primaryDC, err)
	}
	return invoker, nil
}

func (a *App) nativeHealthCheck(account NativeAccount) (NativeAccount, error) {
	account.CheckedAt = now()
	if account.Session == "" {
		account.Ready = false
		account.Status = "needs-relogin"
		account.Error = "Go 原生 MTProto session 尚未创建，请先执行 Go 重新登录"
		return a.saveNativeAccount(account)
	}
	opMu := a.nativeAccountOperationMutex(account.UserID, account.AccountID)
	opMu.Lock()
	defer opMu.Unlock()
	apiHash, err := a.nativeAPIHash(account)
	if err != nil {
		account.Ready = false
		account.Status = "failed"
		account.Error = err.Error()
		_, _ = a.saveNativeAccount(account)
		return account, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Second)
	defer cancel()
	runtime, err := a.acquireNativeRuntime(ctx, account, apiHash)
	if err != nil {
		account.Ready = false
		account.Status = "failed"
		account.Error = err.Error()
		return a.saveNativeAccount(account)
	}
	phase := "连接 Telegram"
	err = func(ctx context.Context) error {
		phase = "验证账号授权"
		authCtx, authCancel := context.WithTimeout(ctx, 15*time.Second)
		status, err := runtime.client.Auth().Status(authCtx)
		authCancel()
		if err != nil {
			return fmt.Errorf("检查 gotd session 授权状态：%w", err)
		}
		if !status.Authorized {
			return errors.New("gotd session 未授权，请重新登录")
		}
		phase = "选择健康检查文件"
		var sample *Task
		if nativeFileUsable(account.HealthFile) {
			sample = &Task{MessageID: account.HealthFile.MessageID, Kind: account.HealthFile.Kind, Size: account.HealthFile.Size, NativeFile: account.HealthFile}
		}
		if sample == nil {
			sample = a.nativeSampleTask(account.UserID, account.AccountID)
			if sample != nil {
				account.HealthFile = sample.NativeFile
				// Health checks only need a current file location. Avoid a competing
				// message refetch while normal downloads are using the same account.
				sample = &Task{MessageID: account.HealthFile.MessageID, Kind: account.HealthFile.Kind, Size: account.HealthFile.Size, NativeFile: account.HealthFile}
			}
		}
		if sample == nil {
			phase = "查找 Telegram 媒体样本"
			discoveryCtx, discoveryCancel := context.WithTimeout(ctx, 55*time.Second)
			sample, err = nativeSampleTaskFromTelegram(discoveryCtx, runtime.api())
			discoveryCancel()
			if err != nil {
				return fmt.Errorf("无法从 Telegram 找到健康检查文件：%w", err)
			}
			account.HealthFile = sample.NativeFile
		}
		sample.UserID = account.UserID
		sample.AccountID = account.AccountID
		phase = "读取 Telegram 文件分片"
		readCtx, readCancel := context.WithTimeout(ctx, 90*time.Second)
		bytesRead, dc, duration, err := a.readNativeSample(readCtx, runtime, *sample)
		readCancel()
		if err != nil {
			return fmt.Errorf("Go 原生文件抽样读取失败：%w", classifyNativeReadError(err))
		}
		account.LastHealthBytes = bytesRead
		account.LastHealthDC = dc
		account.LastHealthDurationMS = duration.Milliseconds()
		account.Error = fmt.Sprintf("健康检查已从 Telegram DC %d 读取 %d 字节，耗时 %d ms", dc, bytesRead, duration.Milliseconds())
		return nil
	}(ctx)
	if err != nil {
		if nativeRuntimeBroken(err) {
			a.invalidateNativeRuntime(account.UserID, account.AccountID)
		}
		account.Ready = false
		account.HealthPasses = 0
		message := strings.ToUpper(err.Error())
		if strings.Contains(message, "AUTH_KEY_UNREGISTERED") || strings.Contains(message, "SESSION_REVOKED") || strings.Contains(message, "未授权") {
			account.Status = "needs-relogin"
		} else {
			account.Status = "failed"
		}
		if errors.Is(err, context.DeadlineExceeded) {
			account.Error = fmt.Sprintf("Go 健康检查在“%s”阶段超时：%s", phase, compactError(err))
		} else {
			account.Error = compactError(err)
		}
		return a.saveNativeAccount(account)
	}
	if account.Ready && account.HealthPasses == 0 {
		account.HealthPasses = 2
	} else {
		account.HealthPasses++
	}
	account.Ready = account.HealthPasses >= 2
	account.Status = "healthy"
	if account.Error == "" {
		account.Error = "Go 原生 MTProto session 健康"
	}
	saved, saveErr := a.saveNativeAccount(account)
	if saveErr != nil {
		return saved, saveErr
	}
	if saved.Ready {
		migrated, migrateErr := a.promoteAccountTasksToNative(saved.UserID, saved.AccountID)
		if migrateErr != nil {
			saved.Error = fmt.Sprintf("Go session 健康，但迁移旧任务失败：%v", migrateErr)
			return a.saveNativeAccount(saved)
		}
		if migrated > 0 {
			saved.Error = fmt.Sprintf("Go session 健康，已将 %d 个旧 HTTP 任务迁移到原生 MTProto 队列", migrated)
			return a.saveNativeAccount(saved)
		}
	}
	return saved, nil
}

func (a *App) promoteAccountTasksToNative(userID, accountID string) (int, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	migrated := a.promoteAccountTasksToNativeLocked(userID, accountID)
	if migrated == 0 {
		return 0, nil
	}
	if err := a.saveLocked(); err != nil {
		return 0, err
	}
	log.Printf("promoted %d legacy HTTP tasks to native MTProto for account %s/%s", migrated, userID, accountID)
	return migrated, nil
}

func (a *App) promoteAccountTasksToNativeLocked(userID, accountID string) int {
	migrated := 0
	for id, task := range a.tasks {
		if task.UserID != userID || task.AccountID != accountID || !nativeTaskRefreshable(*task) {
			continue
		}
		if _, running := a.running[id]; running || task.Status == "completed" || task.Status == "cancelled" {
			continue
		}
		// Native failures need explicit handling. Reconciliation only upgrades
		// legacy HTTP tasks and must not retry a permanent native error forever.
		if normalizeTransport(task.Transport) == "native-mtproto" {
			continue
		}
		task.Transport = "native-mtproto"
		task.Status = "queued"
		task.Error = ""
		task.SpeedBps = 0
		task.RetryCount = 0
		task.RetryAfter = 0
		task.UpdatedAt = now()
		migrated++
	}
	return migrated
}

// Reconcile on every scheduler pass so migration is not tied to the browser
// staying open for the health-check response.
func (a *App) reconcileReadyLegacyTasksLocked() int {
	migrated := 0
	for _, account := range a.native {
		if nativeAccountEligible(*account) {
			migrated += a.promoteAccountTasksToNativeLocked(account.UserID, account.AccountID)
		}
	}
	return migrated
}

func (a *App) promoteTaskToNativeIfReady(taskID string) bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	task := a.tasks[taskID]
	if task == nil || !nativeTaskRefreshable(*task) {
		return false
	}
	account := a.native[nativeAccountKey(task.UserID, task.AccountID)]
	if account == nil || !nativeAccountEligible(*account) {
		return false
	}
	task.Transport = "native-mtproto"
	task.Status = "queued"
	task.Error = ""
	task.SpeedBps = 0
	task.RetryCount = 0
	task.RetryAfter = 0
	task.UpdatedAt = now()
	_ = a.saveLocked()
	return true
}

func (a *App) nativeSampleTask(userID, accountID string) *Task {
	a.mu.Lock()
	defer a.mu.Unlock()
	var selected *Task
	for _, task := range a.tasks {
		if task.UserID == userID && task.AccountID == accountID && task.NativeFile.FileID != "" && task.NativeFile.AccessHash != "" && task.NativeFile.FileReference != "" {
			copy := *task
			if selected == nil || (copy.Size > 0 && (selected.Size <= 0 || copy.Size < selected.Size)) {
				selected = &copy
			}
		}
	}
	return selected
}

func nativeFileUsable(file NativeFileLocation) bool {
	return file.FileID != "" && file.AccessHash != "" && file.FileReference != "" && file.DCID > 0
}

func (a *App) nativeAccountOperationMutex(userID, accountID string) *sync.Mutex {
	key := nativeAccountKey(userID, accountID)
	a.mu.Lock()
	defer a.mu.Unlock()
	if lock := a.nativeOps[key]; lock != nil {
		return lock
	}
	lock := &sync.Mutex{}
	a.nativeOps[key] = lock
	return lock
}

func (a *App) setNativeAccountWait(userID, accountID string, until time.Time) {
	key := nativeAccountKey(userID, accountID)
	a.mu.Lock()
	if until.Unix() > a.nativeWait[key] {
		a.nativeWait[key] = until.Unix()
	}
	a.mu.Unlock()
}

func (a *App) nativeAccountRunningLocked(task Task) bool {
	for id := range a.running {
		runningTask := a.tasks[id]
		if runningTask != nil && runningTask.UserID == task.UserID && runningTask.AccountID == task.AccountID {
			return true
		}
	}
	return false
}

func nativeTaskRefreshable(task Task) bool {
	if nativeFileUsable(task.NativeFile) {
		return true
	}
	if task.MessageID <= 0 || strings.TrimSpace(task.NativePeer.ID) == "" {
		return false
	}
	switch strings.ToLower(strings.TrimSpace(task.NativePeer.Type)) {
	case "channel", "user":
		return strings.TrimSpace(task.NativePeer.AccessHash) != ""
	case "chat":
		return true
	default:
		return false
	}
}

func nativeSampleTaskFromTelegram(ctx context.Context, api *tg.Client) (*Task, error) {
	filters := []tg.MessagesFilterClass{&tg.InputMessagesFilterVideo{}, &tg.InputMessagesFilterDocument{}}
	var searchErrors []string
	for _, filter := range filters {
		searchCtx, cancel := context.WithTimeout(ctx, 18*time.Second)
		result, err := api.MessagesSearchGlobal(searchCtx, &tg.MessagesSearchGlobalRequest{
			Q:          "",
			Filter:     filter,
			OffsetPeer: &tg.InputPeerEmpty{},
			Limit:      20,
		})
		cancel()
		if err != nil {
			searchErrors = append(searchErrors, compactError(err))
			continue
		}
		modified, ok := result.AsModified()
		if !ok {
			searchErrors = append(searchErrors, fmt.Sprintf("unexpected search result: %T", result))
			continue
		}
		if sample := nativeSampleTaskFromMessages(modified.GetMessages()); sample != nil {
			return sample, nil
		}
	}

	dialogCtx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	result, err := api.MessagesGetDialogs(dialogCtx, &tg.MessagesGetDialogsRequest{
		Limit:      40,
		OffsetPeer: &tg.InputPeerEmpty{},
	})
	if err != nil {
		if len(searchErrors) > 0 {
			return nil, fmt.Errorf("媒体搜索失败（%s），会话回退也失败：%w", strings.Join(searchErrors, "; "), classifyNativeReadError(err))
		}
		return nil, classifyNativeReadError(err)
	}
	modified, ok := result.AsModified()
	if !ok {
		return nil, fmt.Errorf("unexpected dialogs result: %T", result)
	}
	if sample := nativeSampleTaskFromMessages(modified.GetMessages()); sample != nil {
		return sample, nil
	}
	return nil, errors.New("Telegram 媒体搜索和最近 40 个会话都没有可读取的文档或视频")
}

func nativeSampleTaskFromMessages(items []tg.MessageClass) *Task {
	for _, item := range items {
		message, ok := item.(*tg.Message)
		if !ok {
			continue
		}
		media, ok := message.GetMedia()
		if !ok {
			continue
		}
		documentMedia, ok := media.(*tg.MessageMediaDocument)
		if !ok {
			continue
		}
		document, ok := documentMedia.Document.(*tg.Document)
		if !ok || document == nil || document.ID == 0 || document.AccessHash == 0 || len(document.FileReference) == 0 {
			continue
		}
		return &Task{
			MessageID: int64(message.ID),
			Kind:      "file",
			Size:      document.Size,
			NativeFile: NativeFileLocation{
				MessageID:     int64(message.ID),
				Kind:          "file",
				FileID:        strconv.FormatInt(document.ID, 10),
				AccessHash:    strconv.FormatInt(document.AccessHash, 10),
				FileReference: base64.StdEncoding.EncodeToString(document.FileReference),
				DCID:          document.DCID,
				Size:          document.Size,
				MimeType:      document.MimeType,
				UpdatedAt:     now(),
			},
		}
	}
	return nil
}

func (a *App) readNativeSample(ctx context.Context, runtime *nativeRuntime, task Task) (int, int, time.Duration, error) {
	started := time.Now()
	metadataAPI := runtime.api()
	if refreshed, err := a.refreshNativeFileLocationFromTelegram(ctx, metadataAPI, task); err == nil {
		task.NativeFile = refreshed
	} else if strings.Contains(err.Error(), "已被删除") {
		return 0, 0, time.Since(started), err
	}
	file := task.NativeFile
	fileID, err := strconv.ParseInt(file.FileID, 10, 64)
	if err != nil {
		return 0, file.DCID, time.Since(started), err
	}
	accessHash, err := strconv.ParseInt(file.AccessHash, 10, 64)
	if err != nil {
		return 0, file.DCID, time.Since(started), err
	}
	fileReference, err := base64.StdEncoding.DecodeString(file.FileReference)
	if err != nil {
		return 0, file.DCID, time.Since(started), err
	}
	fileAPI, err := runtime.fileAPI(file.DCID)
	if err != nil {
		return 0, file.DCID, time.Since(started), fmt.Errorf("打开 Telegram 文件连接：%w", err)
	}
	log.Printf("health sample reusing Telegram file pool for DC %d (primary DC %d)", file.DCID, runtime.primaryDC)
	result, err := fileAPI.UploadGetFile(ctx, &tg.UploadGetFileRequest{
		Precise: true,
		Location: &tg.InputDocumentFileLocation{
			ID:            fileID,
			AccessHash:    accessHash,
			FileReference: fileReference,
		},
		Offset: 0,
		Limit:  64 * 1024,
	})
	if err != nil {
		return 0, file.DCID, time.Since(started), fmt.Errorf("DC %d upload.getFile 读取 64KB 分片：%w", file.DCID, err)
	}
	chunk, ok := result.(*tg.UploadFile)
	if !ok {
		return 0, file.DCID, time.Since(started), fmt.Errorf("健康检查收到不支持的 Telegram 文件响应：%T", result)
	}
	if len(chunk.Bytes) == 0 {
		return 0, file.DCID, time.Since(started), errors.New("Telegram 文件健康检查返回空分片")
	}
	return len(chunk.Bytes), file.DCID, time.Since(started), nil
}

func (a *App) saveNativeAccount(account NativeAccount) (NativeAccount, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	key := nativeAccountKey(account.UserID, account.AccountID)
	existing := a.native[key]
	if existing == nil {
		existing = &NativeAccount{UserID: account.UserID, AccountID: account.AccountID, CreatedAt: coalesce(account.CreatedAt, now())}
		a.native[key] = existing
	}
	existing.Phone = account.Phone
	existing.DisplayName = account.DisplayName
	existing.APIID = account.APIID
	if account.APIHash != "" {
		existing.APIHash = account.APIHash
	}
	existing.Status = normalizeNativeStatus(account.Status, account.Ready)
	existing.Ready = account.Ready
	if account.Session != "" {
		existing.Session = account.Session
	}
	existing.Error = account.Error
	existing.HealthPasses = account.HealthPasses
	existing.LastHealthBytes = account.LastHealthBytes
	existing.LastHealthDC = account.LastHealthDC
	existing.LastHealthDurationMS = account.LastHealthDurationMS
	existing.HealthFile = account.HealthFile
	existing.CheckedAt = account.CheckedAt
	existing.UpdatedAt = now()
	if err := a.saveNativeLocked(); err != nil {
		return *existing, err
	}
	return *existing, nil
}

func (a *App) finalizeNativeAuthorization(userID, accountID string) (NativeAccount, error) {
	for attempt := 0; attempt < 10; attempt++ {
		a.mu.Lock()
		account := a.native[nativeAccountKey(userID, accountID)]
		if account != nil && account.Session != "" {
			account.Ready = false
			account.HealthPasses = 0
			account.LastHealthBytes = 0
			account.LastHealthDC = 0
			account.LastHealthDurationMS = 0
			account.HealthFile = NativeFileLocation{}
			account.Status = "session-imported"
			account.Error = "Go 原生账号已授权，请连续完成 2 次真实文件健康检查"
			account.CheckedAt = ""
			account.UpdatedAt = now()
			result := *account
			err := a.saveNativeLocked()
			a.mu.Unlock()
			return result, err
		}
		a.mu.Unlock()
		time.Sleep(100 * time.Millisecond)
	}
	return NativeAccount{}, errors.New("Telegram 已授权，但 gotd session 尚未持久化，请重新扫码")
}

func (a *App) startNativeLogin(userID, accountID, phone string, apiID int, apiHash string) (nativeLoginResult, error) {
	if phone == "" {
		return nativeLoginResult{}, errors.New("phone is required")
	}
	a.mu.Lock()
	account := a.native[nativeAccountKey(userID, accountID)]
	if account == nil {
		a.mu.Unlock()
		return nativeLoginResult{}, errors.New("native account is not prepared")
	}
	if apiID <= 0 {
		apiID = account.APIID
	}
	if apiHash == "" && account.APIHash != "" {
		var err error
		copy := *account
		a.mu.Unlock()
		apiHash, err = a.nativeAPIHash(copy)
		if err != nil {
			return nativeLoginResult{}, err
		}
		a.mu.Lock()
	}
	if apiID <= 0 || apiHash == "" {
		a.mu.Unlock()
		return nativeLoginResult{}, errors.New("apiId/apiHash is required")
	}
	if account.APIID != apiID {
		account.APIID = apiID
	}
	if apiHash != "" {
		encrypted, err := a.encryptNativeSession([]byte(apiHash))
		if err != nil {
			a.mu.Unlock()
			return nativeLoginResult{}, err
		}
		account.APIHash = encrypted
	}
	account.Phone = phone
	account.Ready = false
	account.Status = "needs-relogin"
	account.Error = ""
	account.UpdatedAt = now()
	_ = a.saveNativeLocked()
	loginID := taskID("native-login", userID, accountID, phone, time.Now().UnixNano())
	ctx, cancel := context.WithCancel(context.Background())
	login := &NativeLogin{
		ID:          loginID,
		UserID:      userID,
		AccountID:   accountID,
		Phone:       phone,
		APIID:       apiID,
		APIHash:     apiHash,
		Status:      "starting",
		Code:        make(chan string, 1),
		Password:    make(chan string, 1),
		Result:      make(chan nativeLoginResult, 2),
		StartResult: make(chan nativeLoginResult, 1),
		Cancel:      cancel,
		CreatedAt:   time.Now(),
		UpdatedAt:   time.Now(),
	}
	a.logins[loginID] = login
	a.mu.Unlock()

	go a.runNativeLogin(ctx, login)
	select {
	case result := <-login.StartResult:
		return result, result.Error
	case <-time.After(40 * time.Second):
		return nativeLoginResult{}, errors.New("发送 Telegram 验证码超时")
	}
}

func (a *App) continueNativeLogin(loginID, step, code, password string) (nativeLoginResult, error) {
	a.mu.Lock()
	login := a.logins[loginID]
	a.mu.Unlock()
	if login == nil {
		return nativeLoginResult{}, errors.New("Go 登录流程不存在或已过期")
	}
	switch step {
	case "code":
		if code == "" {
			return nativeLoginResult{}, errors.New("code is required")
		}
		login.Code <- code
	case "password":
		if password == "" {
			return nativeLoginResult{}, errors.New("password is required")
		}
		login.Password <- password
	default:
		return nativeLoginResult{}, errors.New("unknown login step")
	}
	select {
	case result := <-login.Result:
		if result.Done || result.Error != nil {
			a.mu.Lock()
			delete(a.logins, loginID)
			a.mu.Unlock()
		}
		return result, result.Error
	case <-time.After(60 * time.Second):
		return nativeLoginResult{}, errors.New("等待 Telegram 登录结果超时")
	}
}

func (a *App) startNativeQRLogin(userID, accountID string, apiID int, apiHash string) (nativeQRLoginResult, error) {
	a.mu.Lock()
	account := a.native[nativeAccountKey(userID, accountID)]
	if account == nil {
		a.mu.Unlock()
		return nativeQRLoginResult{}, errors.New("native account is not prepared")
	}
	if apiID <= 0 {
		apiID = account.APIID
	}
	if apiHash == "" && account.APIHash != "" {
		copy := *account
		a.mu.Unlock()
		var err error
		apiHash, err = a.nativeAPIHash(copy)
		if err != nil {
			return nativeQRLoginResult{}, err
		}
		a.mu.Lock()
		account = a.native[nativeAccountKey(userID, accountID)]
	}
	if account == nil {
		a.mu.Unlock()
		return nativeQRLoginResult{}, errors.New("native account is not prepared")
	}
	if apiID <= 0 || apiHash == "" {
		a.mu.Unlock()
		return nativeQRLoginResult{}, errors.New("apiId/apiHash is required")
	}
	if account.APIID != apiID {
		account.APIID = apiID
	}
	if apiHash != "" {
		encrypted, err := a.encryptNativeSession([]byte(apiHash))
		if err != nil {
			a.mu.Unlock()
			return nativeQRLoginResult{}, err
		}
		account.APIHash = encrypted
	}
	account.Ready = false
	account.Session = ""
	account.HealthPasses = 0
	account.LastHealthBytes = 0
	account.LastHealthDC = 0
	account.LastHealthDurationMS = 0
	account.HealthFile = NativeFileLocation{}
	account.Status = "qr-waiting"
	account.Error = ""
	account.UpdatedAt = now()
	_ = a.saveNativeLocked()
	for id, pending := range a.qrLogins {
		if pending.UserID == userID && pending.AccountID == accountID {
			if pending.Cancel != nil {
				pending.Cancel()
			}
			delete(a.qrLogins, id)
		}
	}
	loginID := taskID("native-qr", userID, accountID, time.Now().UnixNano())
	ctx, cancel := context.WithCancel(context.Background())
	login := &NativeQRLogin{
		ID:        loginID,
		UserID:    userID,
		AccountID: accountID,
		APIID:     apiID,
		APIHash:   apiHash,
		Status:    "starting",
		Cancel:    cancel,
		Ready:     make(chan nativeQRLoginResult, 1),
		CreatedAt: time.Now(),
		UpdatedAt: time.Now(),
	}
	a.qrLogins[loginID] = login
	a.mu.Unlock()

	go a.runNativeQRLogin(ctx, login)
	select {
	case result := <-login.Ready:
		if result.Error != "" {
			return result, errors.New(result.Error)
		}
		return result, nil
	case <-time.After(35 * time.Second):
		cancel()
		return nativeQRLoginResult{}, errors.New("生成 Telegram 登录二维码超时")
	}
}

func (a *App) pollNativeQRLogin(loginID string) (nativeQRLoginResult, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	login := a.qrLogins[loginID]
	if login == nil {
		return nativeQRLoginResult{}, errors.New("QR 登录流程不存在或已过期")
	}
	return nativeQRLoginSnapshot(login), nil
}

func (a *App) runNativeQRLogin(ctx context.Context, login *NativeQRLogin) {
	account, err := a.nativeAccountSnapshot(login.UserID, login.AccountID)
	if err != nil {
		a.finishNativeQRLogin(login.ID, NativeAccount{}, err)
		return
	}
	dispatcher := tg.NewUpdateDispatcher()
	loggedIn := qrlogin.OnLoginToken(dispatcher)
	client := telegram.NewClient(account.APIID, login.APIHash, telegram.Options{
		SessionStorage:   nativeSessionStorage{app: a, userID: account.UserID, accountID: account.AccountID},
		UpdateHandler:    dispatcher,
		MigrationTimeout: 30 * time.Second,
		RetryInterval:    time.Second,
		MaxRetries:       5,
	})
	err = client.Run(ctx, func(ctx context.Context) error {
		status, statusErr := client.Auth().Status(ctx)
		if statusErr == nil && status.Authorized {
			return nil
		}
		for {
			_, authErr := client.QR().Auth(ctx, loggedIn, func(_ context.Context, token qrlogin.Token) error {
				a.mu.Lock()
				current := a.qrLogins[login.ID]
				if current == nil {
					a.mu.Unlock()
					return context.Canceled
				}
				current.URL = token.URL()
				current.QRImage = qrPNGDataURL(current.URL)
				current.Expires = token.Expires()
				current.Status = "waiting-scan"
				current.Error = ""
				current.UpdatedAt = time.Now()
				if native := a.native[nativeAccountKey(login.UserID, login.AccountID)]; native != nil {
					native.Status = "qr-waiting"
					native.Error = ""
					native.UpdatedAt = now()
					_ = a.saveNativeLocked()
				}
				result := nativeQRLoginSnapshot(current)
				a.mu.Unlock()
				select {
				case login.Ready <- result:
				default:
				}
				return nil
			})
			if authErr == nil {
				return nil
			}
			status, statusErr := client.Auth().Status(ctx)
			if statusErr == nil && status.Authorized {
				return nil
			}
			if !isExpiredQRTokenError(authErr) {
				return authErr
			}
			log.Printf("native QR token expired for %s; refreshing inside persistent client", login.ID)
			a.markNativeQRRefreshing(login.ID)
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(250 * time.Millisecond):
			}
		}
	})
	if err != nil {
		if errors.Is(err, context.Canceled) {
			return
		}
		a.finishNativeQRLogin(login.ID, NativeAccount{}, err)
		return
	}
	account, err = a.finalizeNativeAuthorization(login.UserID, login.AccountID)
	a.finishNativeQRLogin(login.ID, account, err)
}

func isExpiredQRTokenError(err error) bool {
	if err == nil {
		return false
	}
	message := strings.ToUpper(err.Error())
	return strings.Contains(message, "AUTH_TOKEN_EXPIRED") || strings.Contains(message, "AUTH_TOKEN_INVALID")
}

func (a *App) markNativeQRRefreshing(loginID string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	login := a.qrLogins[loginID]
	if login == nil {
		return
	}
	login.Status = "refreshing"
	login.Error = ""
	login.UpdatedAt = time.Now()
}

func (a *App) finishNativeQRLogin(loginID string, account NativeAccount, runErr error) {
	a.mu.Lock()
	login := a.qrLogins[loginID]
	if login == nil {
		a.mu.Unlock()
		return
	}
	if runErr != nil {
		login.Status = "error"
		login.Error = compactError(runErr)
		if native := a.native[nativeAccountKey(login.UserID, login.AccountID)]; native != nil {
			native.Status = "failed"
			native.Error = login.Error
			native.UpdatedAt = now()
			_ = a.saveNativeLocked()
		}
	} else {
		login.Status = "authorized"
		login.Error = ""
		login.Done = true
		login.Account = account
	}
	login.UpdatedAt = time.Now()
	result := nativeQRLoginSnapshot(login)
	a.mu.Unlock()
	select {
	case login.Ready <- result:
	default:
	}
}

func nativeQRLoginSnapshot(login *NativeQRLogin) nativeQRLoginResult {
	if login == nil {
		return nativeQRLoginResult{}
	}
	result := nativeQRLoginResult{
		Account: login.Account,
		LoginID: login.ID,
		URL:     login.URL,
		QRImage: login.QRImage,
		Status:  login.Status,
		Error:   login.Error,
		Done:    login.Done,
	}
	if !login.Expires.IsZero() {
		result.Expires = login.Expires.Format(time.RFC3339)
	}
	return result
}

func qrPNGDataURL(value string) string {
	code, err := qr.Encode(value, qr.M)
	if err != nil {
		return ""
	}
	return "data:image/png;base64," + base64.StdEncoding.EncodeToString(code.PNG())
}

func (a *App) runNativeLogin(ctx context.Context, login *NativeLogin) {
	account, err := a.nativeAccountSnapshot(login.UserID, login.AccountID)
	if err != nil {
		login.StartResult <- nativeLoginResult{Error: err, LoginID: login.ID}
		return
	}
	account.APIID = login.APIID
	client, err := a.newTelegramClient(account, login.APIHash)
	if err != nil {
		login.StartResult <- nativeLoginResult{Error: err, LoginID: login.ID}
		return
	}
	err = client.Run(ctx, func(ctx context.Context) error {
		status, err := client.Auth().Status(ctx)
		if err == nil && status.Authorized {
			account, err = a.finalizeNativeAuthorization(login.UserID, login.AccountID)
			if err != nil {
				return err
			}
			login.StartResult <- nativeLoginResult{Account: account, LoginID: login.ID, Done: true}
			return nil
		}
		sent, err := client.Auth().SendCode(ctx, login.Phone, auth.SendCodeOptions{AllowAppHash: true})
		if err != nil {
			return err
		}
		codeHash, err := sentCodeHash(sent)
		if err != nil {
			return err
		}
		login.CodeHash = codeHash
		account.Phone = login.Phone
		account.Ready = false
		account.Status = "code-sent"
		account.Error = ""
		account, _ = a.saveNativeAccount(account)
		login.StartResult <- nativeLoginResult{Account: account, LoginID: login.ID, PhoneCodeHash: codeHash}
		code := ""
		select {
		case code = <-login.Code:
		case <-ctx.Done():
			return ctx.Err()
		}
		_, err = client.Auth().SignIn(ctx, login.Phone, code, codeHash)
		if errors.Is(err, auth.ErrPasswordAuthNeeded) {
			account.Status = "password-needed"
			account.Error = ""
			account, _ = a.saveNativeAccount(account)
			login.Result <- nativeLoginResult{Account: account, LoginID: login.ID, PasswordRequired: true}
			password := ""
			select {
			case password = <-login.Password:
			case <-ctx.Done():
				return ctx.Err()
			}
			_, err = client.Auth().Password(ctx, password)
		}
		if err != nil {
			return err
		}
		account, err = a.finalizeNativeAuthorization(login.UserID, login.AccountID)
		if err != nil {
			return err
		}
		login.Result <- nativeLoginResult{Account: account, LoginID: login.ID, Done: true}
		return nil
	})
	if err != nil {
		account.Error = compactError(err)
		account.Ready = false
		account.Status = "failed"
		account, _ = a.saveNativeAccount(account)
		result := nativeLoginResult{Account: account, LoginID: login.ID, Error: err}
		select {
		case login.StartResult <- result:
		default:
		}
		select {
		case login.Result <- result:
		default:
		}
	}
}

func sentCodeHash(sent tg.AuthSentCodeClass) (string, error) {
	if value, ok := sent.(interface{ GetPhoneCodeHash() string }); ok {
		if hash := value.GetPhoneCodeHash(); hash != "" {
			return hash, nil
		}
	}
	if value, ok := sent.(*tg.AuthSentCode); ok {
		return value.PhoneCodeHash, nil
	}
	return "", fmt.Errorf("Telegram 未返回 phone code hash：%T", sent)
}

func classifyNativeReadError(err error) error {
	msg := err.Error()
	switch {
	case strings.Contains(msg, "FILE_REFERENCE_EXPIRED"):
		return fmt.Errorf("FILE_REFERENCE_EXPIRED: 原生 fileReference 已过期，需要刷新消息元数据后自动续传")
	case strings.Contains(msg, "FLOOD_WAIT") || strings.Contains(msg, "FLOOD_PREMIUM_WAIT"):
		return fmt.Errorf("FLOOD_WAIT: Telegram 要求等待后重试：%w", err)
	case strings.Contains(msg, "_MIGRATE_"):
		return fmt.Errorf("DC_MIGRATE: Telegram 要求切换 DC 后重试：%w", err)
	default:
		return err
	}
}

func nativeRuntimeBroken(err error) bool {
	if err == nil {
		return false
	}
	text := strings.ToLower(err.Error())
	markers := []string{"engine was closed", "not connected", "connection closed", "broken pipe", "connection reset"}
	for _, marker := range markers {
		if strings.Contains(text, marker) {
			return true
		}
	}
	return false
}

func migrationDC(err error) int {
	if err == nil {
		return 0
	}
	match := migrateRe.FindStringSubmatch(err.Error())
	if len(match) != 2 {
		return 0
	}
	dc, parseErr := strconv.Atoi(match[1])
	if parseErr != nil || dc <= 0 {
		return 0
	}
	return dc
}

func (a *App) currentPartSize() int64 {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.config.PartSize
}

func (a *App) nativeSecretKey() ([]byte, error) {
	secretFile := strings.TrimSpace(os.Getenv("FEIGRAM_DOWNLOADER_SECRET_FILE"))
	if secretFile == "" {
		secretFile = filepath.Join(a.dataDir, "native-secret")
		if _, err := os.Stat(secretFile); errors.Is(err, os.ErrNotExist) {
			secret := make([]byte, 32)
			if _, err := io.ReadFull(rand.Reader, secret); err != nil {
				return nil, err
			}
			if err := os.WriteFile(secretFile, []byte(hex.EncodeToString(secret)), 0o600); err != nil {
				return nil, err
			}
		}
	}
	secret, err := os.ReadFile(secretFile)
	if err != nil {
		return nil, err
	}
	sum := sha256.Sum256([]byte(strings.TrimSpace(string(secret))))
	return sum[:], nil
}

func boolValue(value any) (bool, bool) {
	switch typed := value.(type) {
	case bool:
		return typed, true
	case string:
		if typed == "true" {
			return true, true
		}
		if typed == "false" {
			return false, true
		}
	}
	return false, false
}

func intValue(value any) (int, bool) {
	if parsed, ok := int64Value(value); ok {
		return int(parsed), true
	}
	return 0, false
}

func int64Value(value any) (int64, bool) {
	switch typed := value.(type) {
	case float64:
		return int64(typed), true
	case int:
		return int64(typed), true
	case int64:
		return typed, true
	case string:
		var parsed int64
		_, err := fmt.Sscan(typed, &parsed)
		return parsed, err == nil
	}
	return 0, false
}

func stringValue(value any) (string, bool) {
	if typed, ok := value.(string); ok && typed != "" {
		return typed, true
	}
	return "", false
}

func withJSON(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		next.ServeHTTP(w, r)
	})
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func taskID(parts ...any) string {
	h := sha1.New()
	for _, part := range parts {
		_, _ = h.Write([]byte(fmt.Sprint(part)))
		_, _ = h.Write([]byte("|"))
	}
	return "go_" + hex.EncodeToString(h.Sum(nil))[:24]
}

func now() string {
	return time.Now().UTC().Format(time.RFC3339Nano)
}

func env(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}

func coalesce(value, fallback string) string {
	if value != "" {
		return value
	}
	return fallback
}

func complete(actualSize, expectedSize int64) bool {
	return actualSize > 0 && (expectedSize <= 0 || actualSize >= expectedSize)
}

func max64(a, b int64) int64 {
	if a > b {
		return a
	}
	return b
}

func maxFloat(a, b float64) float64 {
	if a > b {
		return a
	}
	return b
}

func transientSourceError(err error) bool {
	if err == nil {
		return false
	}
	text := strings.ToLower(err.Error())
	markers := []string{
		"connection refused",
		"unexpected eof",
		"timeout",
		"timed out",
		"connection reset",
		"connection closed",
		"broken pipe",
		"not connected",
		"source returned 408",
		"source returned 425",
		"source returned 429",
		"source returned 500",
		"source returned 502",
		"source returned 503",
		"source returned 504",
		"file_reference_expired",
		"flood_wait",
		"dc_migrate",
		"_migrate",
		"auth_bytes_invalid",
		"retry limit reached",
		"file incomplete",
		"empty file chunk",
		"flood_premium_wait",
		"engine was closed",
	}
	for _, marker := range markers {
		if strings.Contains(text, marker) {
			return true
		}
	}
	return false
}

func recoverableNativeTaskError(err error) bool {
	if err == nil {
		return false
	}
	text := strings.ToLower(err.Error())
	return strings.Contains(text, "auth_bytes_invalid") ||
		strings.Contains(text, "retry limit reached") ||
		strings.Contains(text, "file incomplete") ||
		strings.Contains(text, "empty file chunk") ||
		strings.Contains(text, "flood_wait") ||
		strings.Contains(text, "flood_premium_wait") ||
		strings.Contains(text, "engine was closed") ||
		strings.Contains(text, "not connected") ||
		strings.Contains(text, "broken pipe")
}

func sourceAuthenticationError(err error) bool {
	if err == nil {
		return false
	}
	text := strings.ToLower(err.Error())
	return strings.Contains(text, "source returned 401") ||
		strings.Contains(text, "账号登录已失效") ||
		strings.Contains(text, "auth_key_unregistered")
}

func retryDelay(count int) time.Duration {
	if count < 1 {
		count = 1
	}
	delay := time.Duration(5*(1<<minInt(count-1, 5))) * time.Second
	if delay > 5*time.Minute {
		return 5 * time.Minute
	}
	return delay
}

func floodWaitDelay(err error) time.Duration {
	if err == nil {
		return 0
	}
	match := floodWaitRPCRe.FindStringSubmatch(err.Error())
	if len(match) != 2 {
		match = floodWaitRe.FindStringSubmatch(err.Error())
	}
	if len(match) != 2 {
		return 0
	}
	seconds, parseErr := strconv.Atoi(match[1])
	if parseErr != nil || seconds < 0 {
		return 0
	}
	// Telegram's value is the minimum. Add a small safety margin so the next
	// export/import request does not land on the same server-side window.
	return time.Duration(seconds+2) * time.Second
}

func formatDuration(duration time.Duration) string {
	if duration < time.Minute {
		return fmt.Sprintf("%d 秒", int(duration.Seconds()))
	}
	return fmt.Sprintf("%d 分钟", int(duration.Minutes()))
}

func compactError(err error) string {
	text := strings.TrimSpace(err.Error())
	if len(text) > 180 {
		return text[:180] + "..."
	}
	return text
}

func minInt(a, b int) int {
	if a < b {
		return a
	}
	return b
}
