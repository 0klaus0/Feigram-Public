package main

import (
	"crypto/sha1"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

const (
	version         = "0.2.1"
	defaultPartSize = 1024 * 1024
)

type Config struct {
	Enabled      bool   `json:"enabled"`
	Concurrency  int    `json:"concurrency"`
	RateLimitBps int64  `json:"rateLimitBps"`
	Mode         string `json:"mode"`
	PartSize     int64  `json:"partSize"`
	Backend      string `json:"backend"`
	UpdatedAt    string `json:"updatedAt"`
}

type Task struct {
	ID          string `json:"id"`
	UserID      string `json:"userId"`
	AccountID   string `json:"accountId"`
	PeerID      string `json:"peerId"`
	MessageID   int64  `json:"messageId"`
	FileName    string `json:"fileName"`
	ContentType string `json:"contentType"`
	Kind        string `json:"kind"`
	Size        int64  `json:"size"`
	Downloaded  int64  `json:"downloaded"`
	SpeedBps    int64  `json:"speedBps"`
	Status      string `json:"status"`
	Source      string `json:"source"`
	AutoCache   bool   `json:"autoCache"`
	SourceURL   string `json:"sourceUrl"`
	FilePath    string `json:"filePath"`
	PartPath    string `json:"partPath"`
	InlineURL   string `json:"inlineUrl"`
	Error       string `json:"error"`
	RetryCount  int    `json:"retryCount"`
	RetryAfter  int64  `json:"retryAfterUnix"`
	Order       int64  `json:"order"`
	CreatedAt   string `json:"createdAt"`
	UpdatedAt   string `json:"updatedAt"`
}

type Store struct {
	Config Config `json:"config"`
	Tasks  []Task `json:"tasks"`
	Meta   Meta   `json:"meta"`
}

type Meta struct {
	StartedAt string `json:"startedAt"`
	PID       int    `json:"pid"`
	Version   string `json:"version"`
}

type App struct {
	mu        sync.Mutex
	dataDir   string
	storePath string
	startedAt time.Time
	config    Config
	tasks     map[string]*Task
	running   map[string]chan struct{}
	client    *http.Client
}

func main() {
	dataDir := env("FEIGRAM_DOWNLOADER_DATA", filepath.Join(env("DATA_DIR", "data"), "downloader"))
	port := env("FEIGRAM_DOWNLOADER_PORT", "3090")
	app := &App{
		dataDir:   dataDir,
		storePath: filepath.Join(dataDir, "tasks.json"),
		startedAt: time.Now(),
		config: Config{
			Enabled:      true,
			Concurrency:  1,
			RateLimitBps: 0,
			Mode:         "conservative",
			PartSize:     defaultPartSize,
			Backend:      "go-sidecar",
			UpdatedAt:    now(),
		},
		tasks:   map[string]*Task{},
		running: map[string]chan struct{}{},
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
		if task.Status != "downloading" && task.Status != "running" {
			task.SpeedBps = 0
		}
		a.tasks[task.ID] = &task
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
		if task.Status != "queued" && task.Status != "error" {
			continue
		}
		if task.SourceURL == "" || task.FilePath == "" {
			continue
		}
		if task.RetryAfter > nowUnix {
			continue
		}
		if _, ok := a.running[task.ID]; ok {
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
	if started {
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
			if transientSourceError(err) {
				delay := retryDelay(task.RetryCount + 1)
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
	if err := os.MkdirAll(filepath.Dir(task.FilePath), 0o755); err != nil {
		return err
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
	return map[string]any{
		"ok":       true,
		"version":  version,
		"pid":      os.Getpid(),
		"uptime":   int(time.Since(a.startedAt).Seconds()),
		"dataDir":  a.dataDir,
		"config":   a.config,
		"counts":   counts,
		"running":  len(a.running),
		"speedBps": speed,
		"tasks":    tasks,
		"strategy": "Go 下载服务已接管队列、断点、限速和落盘；当前媒体源仍通过本机 Telegram 桥接，后续可迁移到 tdl/gotd 原生传输。",
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
	existing.AutoCache = existing.AutoCache || input.AutoCache
	if input.SourceURL != "" {
		existing.SourceURL = input.SourceURL
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
	if input.Order > 0 {
		existing.Order = input.Order
	}
	if existing.Status == "cancelled" || existing.Status == "error" {
		existing.Status = "queued"
		existing.RetryCount = 0
		existing.RetryAfter = 0
	}
	existing.UpdatedAt = now()
	return *existing
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
	return current
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
	}
	for _, marker := range markers {
		if strings.Contains(text, marker) {
			return true
		}
	}
	return false
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
