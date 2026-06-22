package main

import (
	"testing"
	"time"
)

func TestReconcileReadyLegacyTasks(t *testing.T) {
	app := &App{
		tasks: map[string]*Task{
			"legacy": {
				ID:        "legacy",
				UserID:    "user-1",
				AccountID: "account-1",
				Transport: "http-bridge",
				Status:    "error",
				Error:     `source returned 401: {"error":"账号登录已失效"}`,
				NativeFile: NativeFileLocation{
					FileID:        "1",
					AccessHash:    "2",
					FileReference: "AQ==",
					DCID:          4,
				},
			},
		},
		native:  map[string]*NativeAccount{},
		running: map[string]chan struct{}{},
	}
	app.native[nativeAccountKey("user-1", "account-1")] = &NativeAccount{
		UserID:       "user-1",
		AccountID:    "account-1",
		Ready:        true,
		HealthPasses: 4,
		Session:      "session",
		APIID:        1,
		APIHash:      "hash",
	}

	if got := app.reconcileReadyLegacyTasksLocked(); got != 1 {
		t.Fatalf("expected one migrated task, got %d", got)
	}
	task := app.tasks["legacy"]
	if task.Transport != "native-mtproto" || task.Status != "queued" || task.Error != "" {
		t.Fatalf("unexpected migrated task: %+v", task)
	}
}

func TestSourceAuthenticationError(t *testing.T) {
	if !sourceAuthenticationError(assertError("source returned 401: account expired")) {
		t.Fatal("expected HTTP 401 to trigger native takeover")
	}
	if sourceAuthenticationError(assertError("source returned 404: missing")) {
		t.Fatal("did not expect HTTP 404 to trigger native takeover")
	}
}

func TestReconcileDoesNotRestartNativeError(t *testing.T) {
	app := &App{
		tasks: map[string]*Task{
			"native-error": {
				ID:        "native-error",
				UserID:    "user-1",
				AccountID: "account-1",
				Transport: "native-mtproto",
				Status:    "error",
				NativeFile: NativeFileLocation{
					FileID: "1", AccessHash: "2", FileReference: "AQ==", DCID: 4,
				},
			},
		},
		native:  map[string]*NativeAccount{},
		running: map[string]chan struct{}{},
	}
	app.native[nativeAccountKey("user-1", "account-1")] = &NativeAccount{
		UserID: "user-1", AccountID: "account-1", Ready: true, HealthPasses: 2,
		Session: "session", APIID: 1, APIHash: "hash",
	}

	if got := app.reconcileReadyLegacyTasksLocked(); got != 0 {
		t.Fatalf("expected native error to remain stopped, migrated %d tasks", got)
	}
	if app.tasks["native-error"].Status != "error" {
		t.Fatalf("native error was unexpectedly requeued: %+v", app.tasks["native-error"])
	}
}

func TestReconcileLegacyTaskWithPeerMetadata(t *testing.T) {
	app := &App{
		tasks: map[string]*Task{
			"legacy-peer": {
				ID: "legacy-peer", UserID: "user-1", AccountID: "account-1",
				Transport: "http-bridge", Status: "error", MessageID: 42,
				NativePeer: NativePeerLocation{Type: "channel", ID: "100", AccessHash: "200"},
			},
		},
		native: map[string]*NativeAccount{}, running: map[string]chan struct{}{},
	}
	app.native[nativeAccountKey("user-1", "account-1")] = &NativeAccount{
		UserID: "user-1", AccountID: "account-1", Ready: true, HealthPasses: 2,
		Session: "session", APIID: 1, APIHash: "hash",
	}

	if got := app.reconcileReadyLegacyTasksLocked(); got != 1 {
		t.Fatalf("expected peer metadata task to migrate, got %d", got)
	}
	if app.tasks["legacy-peer"].Transport != "native-mtproto" {
		t.Fatalf("legacy peer task was not migrated: %+v", app.tasks["legacy-peer"])
	}
}

func TestCompletedTaskWithMissingFileIsRequeued(t *testing.T) {
	filePath := t.TempDir() + "/missing.mp4"
	app := &App{tasks: map[string]*Task{
		"missing": {
			ID: "missing", UserID: "user-1", AccountID: "account-1",
			Status: "completed", FilePath: filePath, PartPath: filePath + ".part", Size: 1024,
		},
	}}
	task := app.upsertTaskLocked(Task{
		ID: "missing", UserID: "user-1", AccountID: "account-1",
		FilePath: filePath, Size: 1024,
	})
	if task.Status != "queued" {
		t.Fatalf("expected missing completed file to be requeued, got %+v", task)
	}
}

func TestRecoverableNativeTaskErrors(t *testing.T) {
	for _, message := range []string{"AUTH_BYTES_INVALID", "retry limit reached after 5 attempts", "file incomplete: 1 / 2", "FLOOD_PREMIUM_WAIT (3)", "empty file chunk", "engine was closed", "engine forcibly closed: context canceled", "Not connected"} {
		if !recoverableNativeTaskError(assertError(message)) {
			t.Fatalf("expected %q to be recoverable", message)
		}
	}
}

func TestNativeFilePoolBroken(t *testing.T) {
	for _, message := range []string{"engine forcibly closed: context canceled", "retry limit reached after 5 attempts", "AUTH_BYTES_INVALID"} {
		if !nativeFilePoolBroken(assertError(message)) {
			t.Fatalf("expected %q to rebuild the file pool", message)
		}
	}
	if nativeFilePoolBroken(assertError("FILE_REFERENCE_EXPIRED")) {
		t.Fatal("file reference refresh should not rebuild a healthy file pool")
	}
}

func TestFloodWaitDelay(t *testing.T) {
	for _, test := range []struct {
		message string
		want    time.Duration
	}{
		{"FLOOD_WAIT (5)", 7 * time.Second},
		{"rpc error 420: FLOOD_PREMIUM_WAIT (3)", 5 * time.Second},
		{"connect Telegram file DC 1: rpc error code 420: FLOOD_WAIT (141)", 143 * time.Second},
		{"TIMEOUT", 0},
	} {
		if got := floodWaitDelay(assertError(test.message)); got != test.want {
			t.Fatalf("floodWaitDelay(%q) = %s, want %s", test.message, got, test.want)
		}
	}
}

func TestNativeAccountRunningLocked(t *testing.T) {
	app := &App{
		tasks: map[string]*Task{
			"running": {ID: "running", UserID: "user-1", AccountID: "account-1"},
		},
		running: map[string]chan struct{}{"running": make(chan struct{})},
	}
	if !app.nativeAccountRunningLocked(Task{UserID: "user-1", AccountID: "account-1"}) {
		t.Fatal("expected same account to be detected as running")
	}
	if app.nativeAccountRunningLocked(Task{UserID: "user-1", AccountID: "account-2"}) {
		t.Fatal("different account should remain eligible for global concurrency")
	}
}

type assertError string

func (e assertError) Error() string { return string(e) }
