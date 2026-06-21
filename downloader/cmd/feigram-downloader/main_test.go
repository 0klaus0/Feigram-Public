package main

import "testing"

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

type assertError string

func (e assertError) Error() string { return string(e) }
