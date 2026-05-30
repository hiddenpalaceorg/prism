//! Curator native Windows GUI (windows-rs).
//!
//! A classic Win32 app calling `curator-core` in-process: a TreeView of the analyzed
//! filesystem on the left, the DAT/XML document on the right, a progress bar + status
//! bar at the bottom, and File ▸ Open. Analysis runs on a worker thread; progress and
//! completion are marshaled back to the UI thread via `PostMessageW`.
//!
//! This file is `#[cfg(windows)]`-gated; on other hosts it builds to a stub so the
//! crate is still well-formed. Compile-check from macOS with:
//!   cargo check --manifest-path crates/curator-gui-win/Cargo.toml --target x86_64-pc-windows-gnu

#![cfg_attr(windows, windows_subsystem = "windows")]

#[cfg(not(windows))]
fn main() {
    eprintln!("curator-gui-win targets Windows; build with --target x86_64-pc-windows-*");
}

#[cfg(windows)]
fn main() -> windows::core::Result<()> {
    app::run()
}

#[cfg(windows)]
mod app {
    use std::collections::{HashMap, VecDeque};
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Mutex};

    use curator_core::adapter::AdapterCommand;
    use curator_core::{render, Analyzer, BuildRecord, Config, Event, Node, ProgressObserver};

    use windows::core::{w, PCWSTR, PWSTR, Result};
    use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
    use windows::Win32::Graphics::Gdi::{GetStockObject, HBRUSH, DEFAULT_GUI_FONT};
    use windows::Win32::Networking::WinHttp::*;
    use windows::Win32::System::Com::CoTaskMemFree;
    use windows::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows::Win32::UI::Input::KeyboardAndMouse::EnableWindow;
    use windows::Win32::UI::Controls::Dialogs::{GetOpenFileNameW, OFN_FILEMUSTEXIST, OFN_PATHMUSTEXIST, OPENFILENAMEW};
    use windows::Win32::UI::Controls::{
        InitCommonControlsEx, ICC_BAR_CLASSES, ICC_PROGRESS_CLASS, ICC_TREEVIEW_CLASSES,
        INITCOMMONCONTROLSEX, NMHDR, NMTREEVIEWW, PBM_SETPOS, PBM_SETRANGE32, TVINSERTSTRUCTW,
        TVINSERTSTRUCTW_0, TVITEMW, TVIF_PARAM, TVIF_TEXT, TVI_LAST, TVI_ROOT, TVM_DELETEITEM,
        TVM_INSERTITEMW, TVN_SELCHANGEDW, TVS_HASBUTTONS, TVS_HASLINES, TVS_LINESATROOT,
    };
    use windows::Win32::UI::Shell::{
        DefSubclassProc, DragAcceptFiles, DragFinish, DragQueryFileW, SetWindowSubclass,
        SHBrowseForFolderW, SHGetPathFromIDListW, BIF_RETURNONLYFSDIRS, BROWSEINFOW, HDROP,
    };
    use windows::Win32::UI::WindowsAndMessaging::*;

    // ---- ids & custom messages ----
    const IDM_OPEN: usize = 1;
    const IDM_OPEN_FOLDER: usize = 2;
    const IDM_CANCEL: usize = 3;
    const IDM_EXIT: usize = 4;
    const IDM_SIMILAR: usize = 5;
    const IDM_SUBMIT: usize = 6;
    const IDM_VIEW_OVERVIEW: usize = 7;
    const IDM_VIEW_XML: usize = 8;
    const IDM_VIEW_JSON: usize = 9;
    const IDM_RECENT_BASE: usize = 2000;
    const MAX_RECENT: u32 = 15;

    /// What the right-hand document pane is showing.
    #[derive(Clone, Copy, PartialEq)]
    enum DocView {
        Overview,
        Selection,
        Xml,
        Json,
    }

    const WM_APP_PROGRESS: u32 = WM_APP + 1;
    const WM_APP_DONE: u32 = WM_APP + 2;
    const WM_APP_SERVICE: u32 = WM_APP + 3; // similarity / submit result (boxed String)

    const STATUS_H: i32 = 22;
    const PROGRESS_H: i32 = 16;

    /// A progress event, owned and `Send`, queued for the UI thread.
    enum UiEvent {
        Batch { index: u64, total: u64, name: String },
        Open { id: u64, label: String, total: Option<f64> },
        Progress { id: u64, count: f64 },
        Close { id: u64 },
        Message(String),
    }

    /// Result of a worker analysis, handed to the UI thread via WM_APP_DONE.
    struct AnalysisDone {
        record: BuildRecord,
        xml: String,
        json: String,
        from_cache: bool,
    }

    /// Per-window state (UI thread only; raw HWNDs are not `Send`).
    struct AppState {
        adapter: AdapterCommand,
        data_dir: Option<PathBuf>,
        analyzer: Arc<Mutex<Option<Analyzer>>>,
        tree: HWND,
        edit: HWND,
        status: HWND,
        progress: HWND,
        events: Arc<Mutex<VecDeque<UiEvent>>>,
        cancel: Arc<AtomicBool>,
        totals: HashMap<u64, f64>,
        working: bool,
        /// Canonical JSON of the loaded build (for similarity/submit), if any.
        last_json: Option<String>,
        /// Document-pane content, by view. `view` selects which one is shown.
        view: DocView,
        doc_overview: String,
        doc_xml: String,
        /// Per-file metadata text, indexed by the tree item's lParam.
        node_details: Vec<String>,
        /// Rendered detail for the currently selected tree node.
        selected_detail: String,
        /// Web service base URL (CURATOR_WEB_URL, default http://localhost:3001).
        web_url: String,
        /// The "Recent" submenu and the sha256s backing its items (by position).
        recent_menu: HMENU,
        recent: Vec<String>,
    }

    /// Construction config passed through `CreateWindowExW`'s lpParam.
    struct InitConfig {
        adapter: AdapterCommand,
        data_dir: Option<PathBuf>,
    }

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    /// Resolve the adapter: env override → bundle next to the exe (`adapter\curator-adapter*`)
    /// → adapter embedded in this exe (single-file build, extracted once) →
    /// `CURATOR_ADAPTER_DIR` → the dev `ps2exe-adapter` uv project.
    fn resolve_adapter() -> AdapterCommand {
        if let Ok(bin) = std::env::var("CURATOR_ADAPTER_BIN") {
            return AdapterCommand::bin(&bin);
        }
        if let Ok(exe) = std::env::current_exe() {
            if let Some(dir) = exe.parent() {
                for name in ["curator-adapter.exe", "curator-adapter.cmd", "curator-adapter.bat", "curator-adapter"] {
                    let p = dir.join("adapter").join(name);
                    if p.exists() {
                        return AdapterCommand::bin(&p.to_string_lossy());
                    }
                }
            }
        }
        #[cfg(embed_adapter)]
        {
            if let Some(p) = extract_embedded_adapter() {
                return AdapterCommand::bin(&p.to_string_lossy());
            }
        }
        let dir = std::env::var("CURATOR_ADAPTER_DIR").unwrap_or_else(|_| "ps2exe-adapter".to_string());
        AdapterCommand::uv(&dir)
    }

    /// The adapter binary frozen into this exe at build time (single-file distribution).
    /// Enabled by build.rs when `CURATOR_ADAPTER_EXE` points at a prebuilt adapter.
    #[cfg(embed_adapter)]
    static EMBEDDED_ADAPTER: &[u8] = include_bytes!(env!("CURATOR_EMBEDDED_ADAPTER"));

    /// Write the embedded adapter to a per-version cache path under TEMP and return it;
    /// skipped if already present. Keyed by GUI version + byte length so an updated build
    /// re-extracts instead of reusing a stale adapter.
    #[cfg(embed_adapter)]
    fn extract_embedded_adapter() -> Option<PathBuf> {
        use std::io::Write;
        let dir = std::env::temp_dir().join("curator");
        std::fs::create_dir_all(&dir).ok()?;
        let exe = dir.join(format!(
            "curator-adapter-{}-{}.exe",
            env!("CARGO_PKG_VERSION"),
            EMBEDDED_ADAPTER.len()
        ));
        if !exe.exists() {
            // Write to a pid-unique temp then rename, so concurrent launches don't tear.
            let tmp = dir.join(format!("curator-adapter.{}.tmp", std::process::id()));
            {
                let mut f = std::fs::File::create(&tmp).ok()?;
                f.write_all(EMBEDDED_ADAPTER).ok()?;
                f.flush().ok()?;
            }
            let _ = std::fs::rename(&tmp, &exe);
            let _ = std::fs::remove_file(&tmp);
        }
        exe.exists().then_some(exe)
    }

    pub fn run() -> Result<()> {
        unsafe {
            let _ = InitCommonControlsEx(&INITCOMMONCONTROLSEX {
                dwSize: std::mem::size_of::<INITCOMMONCONTROLSEX>() as u32,
                dwICC: ICC_TREEVIEW_CLASSES | ICC_BAR_CLASSES | ICC_PROGRESS_CLASS,
            });

            let hinstance = GetModuleHandleW(None)?;
            let class_name = w!("CuratorMainWindow");

            let wc = WNDCLASSW {
                lpfnWndProc: Some(wndproc),
                hInstance: hinstance.into(),
                lpszClassName: class_name,
                hCursor: LoadCursorW(None, IDC_ARROW)?,
                // COLOR_WINDOW (5) + 1, the conventional window-background brush.
                hbrBackground: HBRUSH(6 as *mut core::ffi::c_void),
                ..Default::default()
            };
            RegisterClassW(&wc);

            let init = Box::new(InitConfig { adapter: resolve_adapter(), data_dir: None });

            let hwnd = CreateWindowExW(
                WINDOW_EX_STYLE(0),
                class_name,
                w!("Curator"),
                WS_OVERLAPPEDWINDOW | WS_VISIBLE,
                CW_USEDEFAULT,
                CW_USEDEFAULT,
                980,
                640,
                None,
                None,
                hinstance,
                Some(Box::into_raw(init) as *const core::ffi::c_void),
            )?;

            let _ = ShowWindow(hwnd, SW_SHOW);

            let mut msg = MSG::default();
            while GetMessageW(&mut msg, None, 0, 0).as_bool() {
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
        }
        Ok(())
    }

    unsafe fn state<'a>(hwnd: HWND) -> Option<&'a mut AppState> {
        let ptr = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut AppState;
        ptr.as_mut()
    }

    extern "system" fn wndproc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        unsafe {
            match msg {
                WM_CREATE => {
                    on_create(hwnd, lparam);
                    LRESULT(0)
                }
                WM_SIZE => {
                    if let Some(st) = state(hwnd) {
                        layout(hwnd, st);
                    }
                    LRESULT(0)
                }
                WM_COMMAND => {
                    on_command(hwnd, (wparam.0 & 0xffff) as usize);
                    LRESULT(0)
                }
                WM_NOTIFY => {
                    on_notify(hwnd, lparam);
                    DefWindowProcW(hwnd, msg, wparam, lparam)
                }
                WM_APP_PROGRESS => {
                    drain_progress(hwnd);
                    LRESULT(0)
                }
                WM_APP_DONE => {
                    on_done(hwnd, lparam);
                    LRESULT(0)
                }
                WM_APP_SERVICE => {
                    on_service_result(hwnd, lparam);
                    LRESULT(0)
                }
                WM_DROPFILES => {
                    on_drop(hwnd, wparam);
                    LRESULT(0)
                }
                WM_CLOSE => {
                    // Trip the cancel flag so any in-flight worker stops cooperatively *before*
                    // WM_DESTROY frees AppState (and the Arcs it shares with the worker). The
                    // worker may still post WM_APP_DONE to the now-dead window; that post fails
                    // and is reclaimed by fix #2, so no leak. We don't join (would block the UI).
                    if let Some(st) = state(hwnd) {
                        st.cancel.store(true, Ordering::SeqCst);
                    }
                    let _ = DestroyWindow(hwnd);
                    LRESULT(0)
                }
                WM_DESTROY => {
                    let ptr = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut AppState;
                    if !ptr.is_null() {
                        drop(Box::from_raw(ptr));
                        SetWindowLongPtrW(hwnd, GWLP_USERDATA, 0);
                    }
                    PostQuitMessage(0);
                    LRESULT(0)
                }
                _ => DefWindowProcW(hwnd, msg, wparam, lparam),
            }
        }
    }

    unsafe fn on_create(hwnd: HWND, lparam: LPARAM) {
        let cs = lparam.0 as *const CREATESTRUCTW;
        let init = Box::from_raw((*cs).lpCreateParams as *mut InitConfig);
        let hinst = (*cs).hInstance;

        let child = WS_CHILD | WS_VISIBLE | WS_BORDER;
        let tree = CreateWindowExW(
            WINDOW_EX_STYLE(0),
            w!("SysTreeView32"),
            PCWSTR::null(),
            WINDOW_STYLE(child.0 | TVS_HASLINES | TVS_HASBUTTONS | TVS_LINESATROOT),
            0, 0, 0, 0, hwnd, None, hinst, None,
        )
        .unwrap_or_default();

        let edit = CreateWindowExW(
            WINDOW_EX_STYLE(0),
            w!("EDIT"),
            PCWSTR::null(),
            WINDOW_STYLE(child.0 | (ES_MULTILINE | ES_READONLY | ES_AUTOVSCROLL) as u32)
                | WS_VSCROLL
                | WS_HSCROLL,
            0, 0, 0, 0, hwnd, None, hinst, None,
        )
        .unwrap_or_default();
        // Lift the EDIT control's text cap (default ~32KB for multiline) so large DAT/XML/JSON
        // documents aren't silently truncated. wparam 0 means "maximum".
        let _ = SendMessageW(
            edit,
            windows::Win32::UI::Controls::EM_SETLIMITTEXT,
            WPARAM(0),
            LPARAM(0),
        );

        let status = CreateWindowExW(
            WINDOW_EX_STYLE(0),
            w!("msctls_statusbar32"),
            PCWSTR::null(),
            child,
            0, 0, 0, 0, hwnd, None, hinst, None,
        )
        .unwrap_or_default();

        let progress = CreateWindowExW(
            WINDOW_EX_STYLE(0),
            w!("msctls_progress32"),
            PCWSTR::null(),
            child,
            0, 0, 0, 0, hwnd, None, hinst, None,
        )
        .unwrap_or_default();

        let font = GetStockObject(DEFAULT_GUI_FONT);
        for h in [tree, edit, status] {
            SendMessageW(h, WM_SETFONT, WPARAM(font.0 as usize), LPARAM(1));
        }

        // Drag-and-drop: the panes cover the client area, so accept drops on them and
        // subclass them to forward WM_DROPFILES to the main window.
        DragAcceptFiles(hwnd, true);
        for h in [tree, edit] {
            DragAcceptFiles(h, true);
            let _ = SetWindowSubclass(h, Some(drop_subclass), 1, 0);
        }

        let recent_menu = build_menu(hwnd);

        let st = Box::new(AppState {
            adapter: init.adapter.clone(),
            data_dir: init.data_dir.clone(),
            analyzer: Arc::new(Mutex::new(None)),
            tree,
            edit,
            status,
            progress,
            events: Arc::new(Mutex::new(VecDeque::new())),
            cancel: Arc::new(AtomicBool::new(false)),
            totals: HashMap::new(),
            working: false,
            last_json: None,
            view: DocView::Overview,
            doc_overview: String::new(),
            doc_xml: String::new(),
            node_details: Vec::new(),
            selected_detail: String::new(),
            web_url: std::env::var("CURATOR_WEB_URL")
                .unwrap_or_else(|_| "http://localhost:3001".to_string()),
            recent_menu,
            recent: Vec::new(),
        });
        SetWindowLongPtrW(hwnd, GWLP_USERDATA, Box::into_raw(st) as isize);

        set_status(hwnd, "Open — or drag in — a disc image, container, or folder.");
        if let Some(st) = state(hwnd) {
            layout(hwnd, st);
        }
        refresh_recent(hwnd);
    }

    unsafe fn build_menu(hwnd: HWND) -> HMENU {
        let menu = CreateMenu().unwrap_or_default();
        let file = CreatePopupMenu().unwrap_or_default();
        let recent = CreatePopupMenu().unwrap_or_default();
        let _ = AppendMenuW(file, MF_STRING, IDM_OPEN, w!("&Open Image…\tCtrl+O"));
        let _ = AppendMenuW(file, MF_STRING, IDM_OPEN_FOLDER, w!("Open &Folder…"));
        let _ = AppendMenuW(file, MF_POPUP, recent.0 as usize, w!("Open &Recent"));
        let _ = AppendMenuW(file, MF_SEPARATOR, 0, PCWSTR::null());
        let _ = AppendMenuW(file, MF_STRING, IDM_EXIT, w!("E&xit"));
        let analysis = CreatePopupMenu().unwrap_or_default();
        let _ = AppendMenuW(analysis, MF_STRING, IDM_CANCEL, w!("&Cancel"));
        let _ = AppendMenuW(analysis, MF_SEPARATOR, 0, PCWSTR::null());
        let _ = AppendMenuW(analysis, MF_STRING, IDM_SIMILAR, w!("Find &Similar"));
        let _ = AppendMenuW(analysis, MF_STRING, IDM_SUBMIT, w!("Su&bmit Build…"));
        let view = CreatePopupMenu().unwrap_or_default();
        let _ = AppendMenuW(view, MF_STRING, IDM_VIEW_OVERVIEW, w!("&Overview"));
        let _ = AppendMenuW(view, MF_STRING, IDM_VIEW_XML, w!("&DAT (XML)"));
        let _ = AppendMenuW(view, MF_STRING, IDM_VIEW_JSON, w!("&JSON"));
        let _ = AppendMenuW(menu, MF_POPUP, file.0 as usize, w!("&File"));
        let _ = AppendMenuW(menu, MF_POPUP, view.0 as usize, w!("&View"));
        let _ = AppendMenuW(menu, MF_POPUP, analysis.0 as usize, w!("&Analysis"));
        let _ = SetMenu(hwnd, menu);
        recent
    }

    unsafe fn layout(hwnd: HWND, st: &AppState) {
        let mut rc = windows::Win32::Foundation::RECT::default();
        if GetClientRect(hwnd, &mut rc).is_err() {
            return;
        }
        let w = rc.right - rc.left;
        let h = rc.bottom - rc.top;
        let content_h = (h - STATUS_H - PROGRESS_H).max(0);
        let tree_w = (w as f32 * 0.38) as i32;

        let _ = MoveWindow(st.tree, 0, 0, tree_w, content_h, true);
        let _ = MoveWindow(st.edit, tree_w, 0, (w - tree_w).max(0), content_h, true);
        let _ = MoveWindow(st.progress, 0, content_h, w, PROGRESS_H, true);
        let _ = MoveWindow(st.status, 0, content_h + PROGRESS_H, w, STATUS_H, true);
    }

    unsafe fn on_command(hwnd: HWND, id: usize) {
        match id {
            IDM_OPEN => {
                if let Some(path) = pick_file(hwnd) {
                    start_analysis(hwnd, path);
                }
            }
            IDM_OPEN_FOLDER => {
                if let Some(path) = pick_folder(hwnd) {
                    start_analysis(hwnd, path);
                }
            }
            IDM_CANCEL => {
                if let Some(st) = state(hwnd) {
                    st.cancel.store(true, Ordering::SeqCst);
                    set_status(hwnd, "Cancelling…");
                }
            }
            IDM_SIMILAR => find_similar(hwnd),
            IDM_SUBMIT => submit_build(hwnd),
            IDM_VIEW_OVERVIEW => set_view(hwnd, DocView::Overview),
            IDM_VIEW_XML => set_view(hwnd, DocView::Xml),
            IDM_VIEW_JSON => set_view(hwnd, DocView::Json),
            IDM_EXIT => {
                let _ = DestroyWindow(hwnd);
            }
            other if other >= IDM_RECENT_BASE && other < IDM_RECENT_BASE + MAX_RECENT as usize => {
                open_recent(hwnd, other - IDM_RECENT_BASE);
            }
            _ => {}
        }
    }

    unsafe fn pick_file(hwnd: HWND) -> Option<String> {
        let mut buf = [0u16; 1024];
        let mut ofn = OPENFILENAMEW {
            lStructSize: std::mem::size_of::<OPENFILENAMEW>() as u32,
            hwndOwner: hwnd,
            lpstrFile: PWSTR(buf.as_mut_ptr()),
            nMaxFile: buf.len() as u32,
            lpstrFilter: w!("Disc images & containers\0*.bin;*.iso;*.cue;*.img;*.chd;*.zip;*.7z;*.rar\0All files\0*.*\0"),
            Flags: OFN_FILEMUSTEXIST | OFN_PATHMUSTEXIST,
            ..Default::default()
        };
        if GetOpenFileNameW(&mut ofn).as_bool() {
            let end = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
            Some(String::from_utf16_lossy(&buf[..end]))
        } else {
            None
        }
    }

    unsafe fn pick_folder(hwnd: HWND) -> Option<String> {
        let mut display = [0u16; 260];
        let mut bi = BROWSEINFOW {
            hwndOwner: hwnd,
            pszDisplayName: PWSTR(display.as_mut_ptr()),
            lpszTitle: w!("Select a folder to analyze"),
            ulFlags: BIF_RETURNONLYFSDIRS as u32,
            ..Default::default()
        };
        let pidl = SHBrowseForFolderW(&mut bi);
        if pidl.is_null() {
            return None;
        }
        let mut path = [0u16; 260];
        let ok = SHGetPathFromIDListW(pidl, &mut path).as_bool();
        CoTaskMemFree(Some(pidl as *const core::ffi::c_void));
        if ok {
            Some(String::from_utf16_lossy(&path).trim_end_matches('\0').to_string())
        } else {
            None
        }
    }

    unsafe fn start_analysis(hwnd: HWND, path: String) {
        let Some(st) = state(hwnd) else { return };
        if st.working {
            return;
        }
        st.working = true;
        st.cancel.store(false, Ordering::SeqCst);
        st.totals.clear();
        st.events.lock().unwrap().clear();
        let _ = SendMessageW(st.progress, PBM_SETPOS, WPARAM(0), LPARAM(0));
        set_status(hwnd, &format!("Analyzing {path}…"));

        let events = st.events.clone();
        let cancel = st.cancel.clone();
        let analyzer = st.analyzer.clone();
        let adapter = st.adapter.clone();
        let data_dir = st.data_dir.clone();
        let hwnd_i = hwnd.0 as isize;

        std::thread::spawn(move || {
            let outcome: std::result::Result<AnalysisDone, String> = (|| {
                let mut guard = analyzer.lock().unwrap();
                if guard.is_none() {
                    *guard = Some(
                        Analyzer::new(Config { adapter, data_dir }).map_err(|e| e.to_string())?,
                    );
                }
                let obs: Arc<dyn ProgressObserver> =
                    Arc::new(WinObserver { hwnd: hwnd_i, events, cancel });
                let analysis = guard
                    .as_ref()
                    .unwrap()
                    .analyze(&path, obs)
                    .map_err(|e| e.to_string())?;
                let xml = render::to_dat_xml(&analysis.record);
                let json = render::to_json(&analysis.record).map_err(|e| e.to_string())?;
                Ok(AnalysisDone { record: analysis.record, xml, json, from_cache: analysis.from_cache })
            })();

            let ptr = Box::into_raw(Box::new(outcome));
            // SAFETY: `ptr` is a live `Box<Result<AnalysisDone, String>>` matching what the
            // WM_APP_DONE handler (`on_done`) reclaims. If the target window is already gone
            // PostMessageW fails and would otherwise leak the heap payload, so we take it back.
            if PostMessageW(
                HWND(hwnd_i as *mut core::ffi::c_void),
                WM_APP_DONE,
                WPARAM(0),
                LPARAM(ptr as isize),
            )
            .is_err()
            {
                drop(Box::from_raw(ptr));
            }
        });
    }

    unsafe fn drain_progress(hwnd: HWND) {
        let Some(st) = state(hwnd) else { return };
        let mut queue = st.events.lock().unwrap();
        while let Some(ev) = queue.pop_front() {
            match ev {
                UiEvent::Batch { index, total, name } => {
                    set_status(hwnd, &format!("Item {}/{}: {}", index + 1, total, name));
                }
                UiEvent::Open { id, label, total } => {
                    if let Some(t) = total {
                        st.totals.insert(id, t);
                    }
                    let _ = SendMessageW(st.progress, PBM_SETRANGE32, WPARAM(0), LPARAM(1000));
                    set_status(hwnd, &label);
                }
                UiEvent::Progress { id, count } => {
                    if let Some(t) = st.totals.get(&id) {
                        if *t > 0.0 {
                            let pos = ((count / *t) * 1000.0) as usize;
                            let _ = SendMessageW(st.progress, PBM_SETPOS, WPARAM(pos), LPARAM(0));
                        }
                    }
                }
                UiEvent::Close { id } => {
                    st.totals.remove(&id);
                    let _ = SendMessageW(st.progress, PBM_SETPOS, WPARAM(0), LPARAM(0));
                }
                UiEvent::Message(text) => set_status(hwnd, &text),
            }
        }
    }

    unsafe fn on_done(hwnd: HWND, lparam: LPARAM) {
        let ptr = lparam.0 as *mut std::result::Result<AnalysisDone, String>;
        if ptr.is_null() {
            return;
        }
        let outcome = *Box::from_raw(ptr);
        if let Some(st) = state(hwnd) {
            st.working = false;
            let _ = SendMessageW(st.progress, PBM_SETPOS, WPARAM(0), LPARAM(0));
        }
        match outcome {
            Ok(done) => {
                display_build(hwnd, done);
                refresh_recent(hwnd);
            }
            Err(msg) => {
                set_status(hwnd, "Failed.");
                error_box(hwnd, &msg);
            }
        }
    }

    /// Render a (freshly analyzed or cache-loaded) build into the tree + document pane.
    /// The pane opens on the formatted Overview; the DAT/XML and JSON are available under
    /// the View menu, and clicking a tree node shows that file's metadata.
    unsafe fn display_build(hwnd: HWND, done: AnalysisDone) {
        let tag = if done.from_cache { "cached" } else { "analyzed" };
        let msg = format!(
            "[{tag}] {} — {}, {} files",
            done.record.image.sha256, done.record.info.system, done.record.structural.file_count
        );
        if let Some(st) = state(hwnd) {
            st.node_details = populate_tree(st.tree, &done.record);
            st.last_json = Some(done.json.clone());
            st.doc_xml = done.xml.replace('\n', "\r\n");
            st.doc_overview = render_overview(&done.record);
            st.selected_detail = String::new();
            st.view = DocView::Overview;
        }
        refresh_doc(hwnd);
        set_status(hwnd, &msg);
    }

    /// Push the active view's text into the document pane.
    unsafe fn refresh_doc(hwnd: HWND) {
        let Some(st) = state(hwnd) else { return };
        let text = match st.view {
            DocView::Overview => st.doc_overview.clone(),
            DocView::Selection => st.selected_detail.clone(),
            DocView::Xml => st.doc_xml.clone(),
            DocView::Json => st.last_json.clone().unwrap_or_default(),
        };
        let w = wide(&text);
        let _ = SetWindowTextW(st.edit, PCWSTR(w.as_ptr()));
    }

    unsafe fn set_view(hwnd: HWND, view: DocView) {
        if let Some(st) = state(hwnd) {
            st.view = view;
        }
        refresh_doc(hwnd);
    }

    /// Tree-selection handler: show the picked node's metadata in the document pane.
    unsafe fn on_notify(hwnd: HWND, lparam: LPARAM) {
        let nmhdr = &*(lparam.0 as *const NMHDR);
        let (from, code) = (nmhdr.hwndFrom, nmhdr.code);
        let mut changed = false;
        if let Some(st) = state(hwnd) {
            if from == st.tree && code == TVN_SELCHANGEDW {
                let tv = &*(lparam.0 as *const NMTREEVIEWW);
                let idx = tv.itemNew.lParam.0 as usize;
                if let Some(detail) = st.node_details.get(idx) {
                    st.selected_detail = detail.clone();
                    st.view = DocView::Selection;
                    changed = true;
                }
            }
        }
        if changed {
            refresh_doc(hwnd);
        }
    }

    /// Build the analyzer (catalog + cache) on demand. Returns false if it can't open.
    unsafe fn ensure_analyzer(st: &AppState) -> bool {
        let mut g = st.analyzer.lock().unwrap();
        if g.is_none() {
            match Analyzer::new(Config { adapter: st.adapter.clone(), data_dir: st.data_dir.clone() }) {
                Ok(a) => *g = Some(a),
                Err(_) => return false,
            }
        }
        true
    }

    /// Repopulate the File ▸ Open Recent submenu from the local catalog.
    unsafe fn refresh_recent(hwnd: HWND) {
        let Some(st) = state(hwnd) else { return };
        if !ensure_analyzer(st) {
            return;
        }
        let rows = st
            .analyzer
            .lock()
            .unwrap()
            .as_ref()
            .map(|a| a.recent_builds(MAX_RECENT).unwrap_or_default())
            .unwrap_or_default();

        while DeleteMenu(st.recent_menu, 0, MF_BYPOSITION).is_ok() {}
        st.recent.clear();
        if rows.is_empty() {
            let _ = AppendMenuW(st.recent_menu, MF_STRING | MF_GRAYED, 0, w!("(none yet)"));
            return;
        }
        for (i, r) in rows.iter().enumerate() {
            let label = wide(&format!("{}  —  {}", r.name, r.system));
            let _ = AppendMenuW(st.recent_menu, MF_STRING, IDM_RECENT_BASE + i, PCWSTR(label.as_ptr()));
            st.recent.push(r.sha256.clone());
        }
    }

    /// Reopen a catalogued build from cache (no re-analysis).
    unsafe fn open_recent(hwnd: HWND, idx: usize) {
        // A single `&mut AppState`, scoped so it is dropped before `display_build` (which
        // re-derives its own &mut); holding two simultaneously would be aliasing UB.
        let loaded = {
            let Some(st) = state(hwnd) else { return };
            let Some(sha) = st.recent.get(idx).cloned() else { return };
            if st.working || !ensure_analyzer(st) {
                return;
            }
            st.analyzer.lock().unwrap().as_ref().and_then(|a| a.load_cached(&sha).ok().flatten())
        };
        match loaded {
            Some(analysis) => {
                let xml = render::to_dat_xml(&analysis.record);
                match render::to_json(&analysis.record) {
                    Ok(json) => {
                        display_build(hwnd, AnalysisDone { record: analysis.record, xml, json, from_cache: true });
                    }
                    Err(e) => set_status(hwnd, &format!("Failed to render record: {e}")),
                }
            }
            None => set_status(hwnd, "Build not in cache anymore."),
        }
    }

    /// WM_DROPFILES: analyze the first dropped path.
    unsafe fn on_drop(hwnd: HWND, wparam: WPARAM) {
        let hdrop = HDROP(wparam.0 as *mut core::ffi::c_void);
        let mut buf = [0u16; 1024];
        let n = DragQueryFileW(hdrop, 0, Some(&mut buf));
        DragFinish(hdrop);
        if n > 0 {
            start_analysis(hwnd, String::from_utf16_lossy(&buf[..n as usize]));
        }
    }

    /// Subclass proc on the panes: forward dropped files to the main window.
    unsafe extern "system" fn drop_subclass(
        hwnd: HWND,
        msg: u32,
        wparam: WPARAM,
        lparam: LPARAM,
        _id: usize,
        _data: usize,
    ) -> LRESULT {
        if msg == WM_DROPFILES {
            if let Ok(parent) = GetParent(hwnd) {
                on_drop(parent, wparam);
            }
            return LRESULT(0);
        }
        DefSubclassProc(hwnd, msg, wparam, lparam)
    }

    /// Fill the tree and return per-node detail text, indexed by each item's lParam.
    unsafe fn populate_tree(tree: HWND, record: &BuildRecord) -> Vec<String> {
        let _ = SendMessageW(tree, TVM_DELETEITEM, WPARAM(0), LPARAM(TVI_ROOT.0));
        let mut details = Vec::new();
        for node in &record.contents {
            insert_node(tree, TVI_ROOT, node, &mut details);
        }
        details
    }

    unsafe fn insert_node(
        tree: HWND,
        parent: windows::Win32::UI::Controls::HTREEITEM,
        node: &Node,
        details: &mut Vec<String>,
    ) {
        let idx = details.len();
        details.push(render_node_detail(node));
        let mut label = wide(node.name());
        let mut item = TVITEMW::default();
        item.mask = TVIF_TEXT | TVIF_PARAM;
        item.pszText = PWSTR(label.as_mut_ptr());
        item.lParam = LPARAM(idx as isize);
        let ins = TVINSERTSTRUCTW {
            hParent: parent,
            hInsertAfter: TVI_LAST,
            Anonymous: TVINSERTSTRUCTW_0 { item },
        };
        let lr = SendMessageW(tree, TVM_INSERTITEMW, WPARAM(0), LPARAM(&ins as *const _ as isize));
        let handle = windows::Win32::UI::Controls::HTREEITEM(lr.0);
        if let Node::Dir { children, .. } = node {
            for child in children {
                insert_node(tree, handle, child, details);
            }
        }
    }

    fn human_size(bytes: u64) -> String {
        const UNITS: [&str; 5] = ["B", "KB", "MB", "GB", "TB"];
        if bytes < 1024 {
            return format!("{bytes} B");
        }
        let mut value = bytes as f64;
        let mut i = 0;
        while value >= 1024.0 && i < UNITS.len() - 1 {
            value /= 1024.0;
            i += 1;
        }
        format!("{value:.1} {}", UNITS[i])
    }

    /// `19970414` → `1997-04-14`; anything else is returned unchanged.
    fn pretty_date(s: &str) -> String {
        if s.len() == 8 && s.bytes().all(|b| b.is_ascii_digit()) {
            format!("{}-{}-{}", &s[0..4], &s[4..6], &s[6..8])
        } else {
            s.to_string()
        }
    }

    /// Per-file metadata table shown when a tree node is selected.
    fn render_node_detail(node: &Node) -> String {
        let mut s = String::new();
        let mut row = |label: &str, val: &str| {
            if !val.is_empty() {
                s.push_str(&format!("{label:<10}{val}\r\n"));
            }
        };
        match node {
            Node::Dir { name, date, size, children } => {
                row("Name", name);
                row("Type", "Directory");
                if let Some(d) = date {
                    row("Date", d);
                }
                if let Some(sz) = size {
                    row("Size", &human_size(*sz));
                }
                row("Items", &children.len().to_string());
            }
            Node::File { name, date, size, md5, sha1, sha256, unreadable } => {
                row("Name", name);
                row("Type", "File");
                if let Some(sz) = size {
                    row("Size", &human_size(*sz));
                }
                if let Some(d) = date {
                    row("Date", d);
                }
                if *unreadable {
                    row("Status", "Unreadable (bad dump)");
                }
                if let Some(h) = md5 {
                    row("MD5", h);
                }
                if let Some(h) = sha1 {
                    row("SHA-1", h);
                }
                if let Some(h) = sha256 {
                    row("SHA-256", h);
                }
            }
        }
        s
    }

    /// Formatted build metadata — the readable counterpart to the raw DAT/XML, shown on load.
    fn render_overview(record: &BuildRecord) -> String {
        let mut s = String::new();
        let section = |s: &mut String, title: &str| {
            s.push_str(&format!("\r\n── {title} {}\r\n", "─".repeat(38_usize.saturating_sub(title.len()))));
        };
        let row = |s: &mut String, label: &str, val: &str| {
            if !val.is_empty() {
                s.push_str(&format!("  {label:<16}{val}\r\n"));
            }
        };

        let img = &record.image;
        s.push_str(&format!("── Image {}\r\n", "─".repeat(33)));
        row(&mut s, "Name", &img.name);
        row(&mut s, "Size", &human_size(img.size));
        row(&mut s, "MD5", &img.md5);
        row(&mut s, "SHA-1", &img.sha1);
        row(&mut s, "SHA-256", &img.sha256);

        let info = &record.info;
        section(&mut s, "Disc");
        row(&mut s, "System", &info.system);
        if let Some(v) = &info.system_identifier {
            row(&mut s, "System ID", v);
        }
        if let Some(v) = &info.disc_type {
            row(&mut s, "Disc type", v);
        }

        let h = &info.header;
        if !h.is_empty() {
            section(&mut s, "Header");
            if let Some(v) = &h.title {
                row(&mut s, "Title", v);
            }
            if let Some(v) = &h.product_number {
                row(&mut s, "Product No.", v);
            }
            if let Some(v) = &h.product_version {
                row(&mut s, "Version", v);
            }
            if let Some(v) = &h.release_date {
                row(&mut s, "Release date", &pretty_date(v));
            }
            if let Some(v) = &h.maker_id {
                row(&mut s, "Maker", v);
            }
            if let Some(v) = &h.device_info {
                row(&mut s, "Device", v);
            }
            if let Some(v) = &h.regions {
                row(&mut s, "Regions", v);
            }
        }

        let vol = &info.volume;
        if !vol.is_empty() {
            section(&mut s, "Volume");
            if let Some(v) = &vol.identifier {
                row(&mut s, "Identifier", v);
            }
            if let Some(v) = &vol.set_identifier {
                row(&mut s, "Set identifier", v);
            }
            if let Some(v) = &vol.creation_date {
                row(&mut s, "Created", v);
            }
            if let Some(v) = &vol.modification_date {
                row(&mut s, "Modified", v);
            }
        }

        if let Some(e) = &info.exe {
            section(&mut s, "Boot executable");
            row(&mut s, "Filename", &e.filename);
            if let Some(v) = &e.date {
                row(&mut s, "Date", v);
            }
        }

        let c = &record.composites;
        if c.content_hash.is_some()
            || c.filtered_content_hash.is_some()
            || c.hash_exe.is_some()
            || c.incomplete_files > 0
        {
            section(&mut s, "Content");
            if let Some(v) = &c.content_hash {
                row(&mut s, "Content hash", v);
            }
            if let Some(v) = &c.filtered_content_hash {
                row(&mut s, "Filtered hash", v);
            }
            if let Some(v) = &c.hash_exe {
                row(&mut s, "Boot exe hash", v);
            }
            if let Some(m) = &c.most_recent_file {
                row(&mut s, "Most recent", &m.path);
            }
            if c.incomplete_files > 0 {
                row(&mut s, "Incomplete", &c.incomplete_files.to_string());
            }
        }

        let st = &record.structural;
        section(&mut s, "Structure");
        row(&mut s, "Files", &st.file_count.to_string());
        row(&mut s, "Total size", &human_size(st.total_size));
        row(&mut s, "Max depth", &st.max_depth.to_string());
        if !st.ext_histogram.is_empty() {
            let mut exts: Vec<_> = st.ext_histogram.iter().collect();
            exts.sort_by(|a, b| b.1.cmp(a.1).then(a.0.cmp(b.0)));
            let top = exts
                .iter()
                .take(8)
                .map(|(k, v)| format!("{}×{}", if k.is_empty() { "(none)" } else { k }, v))
                .collect::<Vec<_>>()
                .join(", ");
            row(&mut s, "Top extensions", &top);
        }

        s
    }

    // ---- modal error dialog (selectable, copyable) ----

    struct ErrorState {
        /// CRLF-normalized, NUL-terminated message for the read-only edit control.
        text: Vec<u16>,
        edit: HWND,
        done: bool,
    }

    const IDC_ERR_COPY: usize = 110;
    const IDC_ERR_CLOSE: usize = 111;
    const EM_SETSEL_MSG: u32 = 0x00B1;
    const WM_COPY_MSG: u32 = 0x0301;

    /// Show a dismissable modal error dialog (in addition to the status-bar note).
    /// Adapter failures are often long multi-line tracebacks; a read-only multiline
    /// edit control lets the user select and copy the text (Ctrl+C or "Copy all"),
    /// which a plain MessageBox does not.
    unsafe fn error_box(owner: HWND, text: &str) {
        let Ok(hinstance) = GetModuleHandleW(None) else { return };
        let class = w!("CuratorError");
        let wc = WNDCLASSW {
            lpfnWndProc: Some(error_proc),
            hInstance: hinstance.into(),
            lpszClassName: class,
            hCursor: LoadCursorW(None, IDC_ARROW).unwrap_or_default(),
            hbrBackground: HBRUSH(6 as *mut core::ffi::c_void),
            ..Default::default()
        };
        RegisterClassW(&wc); // idempotent enough for a one-window app

        let mut es = ErrorState {
            text: wide(&text.replace("\r\n", "\n").replace('\n', "\r\n")),
            edit: HWND::default(),
            done: false,
        };
        let Ok(dlg) = CreateWindowExW(
            WINDOW_EX_STYLE(0),
            class,
            w!("Curator — Analysis failed"),
            WS_POPUPWINDOW | WS_CAPTION | WS_THICKFRAME | WS_VISIBLE,
            CW_USEDEFAULT,
            CW_USEDEFAULT,
            560,
            380,
            owner,
            None,
            hinstance,
            Some(&mut es as *mut ErrorState as *const core::ffi::c_void),
        ) else {
            return;
        };

        let _ = EnableWindow(owner, false);
        let mut msg = MSG::default();
        while !es.done && GetMessageW(&mut msg, None, 0, 0).as_bool() {
            if !IsDialogMessageW(dlg, &msg).as_bool() {
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
        }
        let _ = EnableWindow(owner, true);
        let _ = SetForegroundWindow(owner);
        let _ = DestroyWindow(dlg);
    }

    extern "system" fn error_proc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        unsafe {
            match msg {
                WM_CREATE => {
                    let cs = lparam.0 as *const CREATESTRUCTW;
                    let es = (*cs).lpCreateParams as *mut ErrorState;
                    SetWindowLongPtrW(hwnd, GWLP_USERDATA, es as isize);
                    let hinst = (*cs).hInstance;
                    let edit_style = WS_CHILD
                        | WS_VISIBLE
                        | WS_BORDER
                        | WS_VSCROLL
                        | WINDOW_STYLE((ES_MULTILINE | ES_READONLY | ES_AUTOVSCROLL) as u32);
                    let edit = CreateWindowExW(
                        WINDOW_EX_STYLE(0),
                        w!("EDIT"),
                        PCWSTR::null(),
                        edit_style,
                        0, 0, 0, 0, hwnd, None, hinst, None,
                    )
                    .unwrap_or_default();
                    let _ = CreateWindowExW(
                        WINDOW_EX_STYLE(0),
                        w!("BUTTON"),
                        w!("Copy all"),
                        WS_CHILD | WS_VISIBLE,
                        0, 0, 0, 0, hwnd,
                        HMENU(IDC_ERR_COPY as *mut core::ffi::c_void), hinst, None,
                    );
                    let _ = CreateWindowExW(
                        WINDOW_EX_STYLE(0),
                        w!("BUTTON"),
                        w!("Close"),
                        WS_CHILD | WS_VISIBLE | WINDOW_STYLE(BS_DEFPUSHBUTTON as u32),
                        0, 0, 0, 0, hwnd,
                        HMENU(IDC_ERR_CLOSE as *mut core::ffi::c_void), hinst, None,
                    );
                    let font = GetStockObject(DEFAULT_GUI_FONT);
                    for child in child_windows(hwnd) {
                        let _ = SendMessageW(child, WM_SETFONT, WPARAM(font.0 as usize), LPARAM(1));
                    }
                    if let Some(es) = es.as_mut() {
                        es.edit = edit;
                        let _ = SetWindowTextW(edit, PCWSTR(es.text.as_ptr()));
                    }
                    LRESULT(0)
                }
                WM_SIZE => {
                    if let Some(es) = (GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut ErrorState).as_ref() {
                        let w = (lparam.0 & 0xffff) as i32;
                        let h = ((lparam.0 >> 16) & 0xffff) as i32;
                        let (pad, btn_w, btn_h) = (10, 90, 26);
                        let edit_h = (h - btn_h - 3 * pad).max(0);
                        let _ = MoveWindow(es.edit, pad, pad, (w - 2 * pad).max(0), edit_h, true);
                        let btn_y = h - btn_h - pad;
                        let _ = MoveWindow(
                            GetDlgItem(hwnd, IDC_ERR_CLOSE as i32).unwrap_or_default(),
                            w - btn_w - pad, btn_y, btn_w, btn_h, true,
                        );
                        let _ = MoveWindow(
                            GetDlgItem(hwnd, IDC_ERR_COPY as i32).unwrap_or_default(),
                            w - 2 * btn_w - 2 * pad, btn_y, btn_w, btn_h, true,
                        );
                    }
                    LRESULT(0)
                }
                WM_COMMAND => {
                    let id = (wparam.0 & 0xffff) as usize;
                    let es = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut ErrorState;
                    if let Some(es) = es.as_mut() {
                        match id {
                            IDC_ERR_COPY => {
                                // Select all, then copy the selection to the clipboard.
                                let _ = SendMessageW(es.edit, EM_SETSEL_MSG, WPARAM(0), LPARAM(-1));
                                let _ = SendMessageW(es.edit, WM_COPY_MSG, WPARAM(0), LPARAM(0));
                            }
                            // IDC_ERR_CLOSE, or IDOK/IDCANCEL synthesized by Enter/Esc.
                            IDC_ERR_CLOSE | 1 | 2 => es.done = true,
                            _ => {}
                        }
                    }
                    LRESULT(0)
                }
                WM_CLOSE => {
                    if let Some(es) = (GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut ErrorState).as_mut() {
                        es.done = true;
                    }
                    LRESULT(0)
                }
                _ => DefWindowProcW(hwnd, msg, wparam, lparam),
            }
        }
    }

    /// Collect a window's immediate child controls (used to apply the shared GUI font).
    unsafe fn child_windows(parent: HWND) -> Vec<HWND> {
        let mut out = Vec::new();
        let mut child = GetWindow(parent, GW_CHILD).unwrap_or_default();
        while !child.0.is_null() {
            out.push(child);
            child = GetWindow(child, GW_HWNDNEXT).unwrap_or_default();
        }
        out
    }

    unsafe fn set_status(hwnd: HWND, text: &str) {
        if let Some(st) = state(hwnd) {
            let wtext = wide(text);
            let _ = SendMessageW(
                st.status,
                windows::Win32::UI::Controls::SB_SETTEXTW,
                WPARAM(0),
                LPARAM(wtext.as_ptr() as isize),
            );
        }
    }

    // ---- web service: Find Similar / Submit ----

    unsafe fn find_similar(hwnd: HWND) {
        let Some(st) = state(hwnd) else { return };
        let Some(json) = st.last_json.clone() else {
            set_status(hwnd, "Analyze a build first.");
            return;
        };
        let url = format!("{}/api/similarity", st.web_url.trim_end_matches('/'));
        set_status(hwnd, "Querying similar builds…");
        let hwnd_i = hwnd.0 as isize;
        std::thread::spawn(move || {
            let text = match http_post_json(&url, &json) {
                Ok((code, body)) if (200..300).contains(&code) => format_similarity(&body),
                Ok((code, body)) => format!("Server error {code}: {}", body.trim()),
                Err(e) => format!("Cannot reach service: {e}"),
            };
            post_service_result(hwnd_i, text);
        });
    }

    unsafe fn submit_build(hwnd: HWND) {
        let Some(st) = state(hwnd) else { return };
        let Some(json) = st.last_json.clone() else {
            set_status(hwnd, "Analyze a build first.");
            return;
        };
        let Some(nickname) = prompt_nickname(hwnd) else { return };
        if nickname.trim().is_empty() {
            return;
        }
        let url = format!("{}/api/submissions", st.web_url.trim_end_matches('/'));
        // { "nickname": <json string>, "record": <record> } — embed the raw record JSON.
        let body = format!(
            "{{\"nickname\":{},\"record\":{}}}",
            serde_json::Value::String(nickname).to_string(),
            json
        );
        set_status(hwnd, "Submitting build…");
        let hwnd_i = hwnd.0 as isize;
        std::thread::spawn(move || {
            let text = match http_post_json(&url, &body) {
                Ok((code, b)) if (200..300).contains(&code) => {
                    let status = serde_json::from_str::<serde_json::Value>(&b)
                        .ok()
                        .and_then(|v| v.get("status").and_then(|s| s.as_str()).map(String::from))
                        .unwrap_or_else(|| "queued".into());
                    format!("Submitted — {status}.")
                }
                Ok((code, b)) => format!("Server error {code}: {}", b.trim()),
                Err(e) => format!("Cannot reach service: {e}"),
            };
            post_service_result(hwnd_i, text);
        });
    }

    fn post_service_result(hwnd_i: isize, text: String) {
        let ptr = Box::into_raw(Box::new(text));
        // SAFETY: `ptr` is a live `Box<String>` matching what `on_service_result` reclaims.
        // If the window is gone PostMessageW fails; take the allocation back to avoid a leak.
        unsafe {
            if PostMessageW(
                HWND(hwnd_i as *mut core::ffi::c_void),
                WM_APP_SERVICE,
                WPARAM(0),
                LPARAM(ptr as isize),
            )
            .is_err()
            {
                drop(Box::from_raw(ptr));
            }
        }
    }

    unsafe fn on_service_result(hwnd: HWND, lparam: LPARAM) {
        let ptr = lparam.0 as *mut String;
        if ptr.is_null() {
            return;
        }
        let text = *Box::from_raw(ptr);
        // Multi-line similarity output goes to the document pane; one-liners to status.
        if text.contains('\n') {
            if let Some(st) = state(hwnd) {
                let body = text.replace('\n', "\r\n");
                let wbody = wide(&body);
                let _ = SetWindowTextW(st.edit, PCWSTR(wbody.as_ptr()));
            }
        }
        set_status(hwnd, text.lines().next().unwrap_or("").trim());
    }

    /// Render the `/api/similarity` JSON response as a readable neighbor list.
    fn format_similarity(body: &str) -> String {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(body) else {
            return format!("Unexpected response:\n{body}");
        };
        let sections = [
            ("Identical content (Tier 1)", "tier1_twins"),
            ("Shared files (Tier 2)", "tier2"),
            ("Similar chunks (Tier 3)", "tier3"),
            ("Same boot imports (Tier 5)", "tier5_exe"),
            ("Similar executable (TLSH)", "tier5_tlsh"),
            ("Shared audio tracks", "audio_neighbors"),
            ("Semantically related (text)", "text_neighbors"),
        ];
        let mut out = String::from("Similar builds\r\n==============\r\n");
        let mut any = false;
        for (title, key) in sections {
            let Some(arr) = v.get(key).and_then(|x| x.as_array()) else { continue };
            if arr.is_empty() {
                continue;
            }
            any = true;
            out.push_str(&format!("\n{title}\n"));
            for item in arr {
                let name = item.get("name").and_then(|x| x.as_str()).unwrap_or("?");
                let sha = item.get("sha256").and_then(|x| x.as_str()).unwrap_or("");
                let score = item
                    .get("jaccard")
                    .and_then(|x| x.as_f64())
                    .map(|j| format!("  {:.0}%", j * 100.0))
                    .or_else(|| item.get("distance").and_then(|x| x.as_f64()).map(|d| format!("  d={d}")))
                    .or_else(|| item.get("cosine").and_then(|x| x.as_f64()).map(|c| format!("  {c:.2}")))
                    .unwrap_or_default();
                out.push_str(&format!("  {name}  [{}…]{score}\n", &sha.chars().take(12).collect::<String>()));
            }
        }
        if !any {
            out.push_str("\nNo similar builds found.\n");
        }
        out
    }

    /// Native WinHTTP `POST <url>` with a JSON body. Returns (status_code, body).
    unsafe fn http_post_json(url: &str, body: &str) -> std::result::Result<(u32, String), String> {
        // Parse scheme://host[:port]/path (minimal; http/https only).
        let (secure, rest) = if let Some(r) = url.strip_prefix("https://") {
            (true, r)
        } else if let Some(r) = url.strip_prefix("http://") {
            (false, r)
        } else {
            return Err("URL must be http(s)".into());
        };
        let (authority, path) = match rest.find('/') {
            Some(i) => (&rest[..i], &rest[i..]),
            None => (rest, "/"),
        };
        let (host, port) = match authority.rfind(':') {
            Some(i) => (
                &authority[..i],
                authority[i + 1..].parse::<u16>().map_err(|_| "bad port")?,
            ),
            None => (authority, if secure { 443 } else { 80 }),
        };

        let host_w = wide(host);
        let verb_w = wide("POST");
        let path_w = wide(path);
        let headers_w = wide("Content-Type: application/json");

        let session = WinHttpOpen(
            w!("curator-gui-win"),
            WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY,
            PCWSTR::null(),
            PCWSTR::null(),
            0,
        );
        if session.is_null() {
            return Err("WinHttpOpen failed".into());
        }
        // Bound every phase so a hung server can't wedge the worker thread forever
        // (resolve 10s, connect 10s, send 30s, receive 30s; milliseconds).
        let _ = WinHttpSetTimeouts(session, 10_000, 10_000, 30_000, 30_000);
        let result = (|| {
            let conn = WinHttpConnect(session, PCWSTR(host_w.as_ptr()), port, 0);
            if conn.is_null() {
                return Err("WinHttpConnect failed".to_string());
            }
            let flags = if secure { WINHTTP_FLAG_SECURE } else { WINHTTP_OPEN_REQUEST_FLAGS(0) };
            let req = WinHttpOpenRequest(
                conn,
                PCWSTR(verb_w.as_ptr()),
                PCWSTR(path_w.as_ptr()),
                PCWSTR::null(),
                PCWSTR::null(),
                std::ptr::null_mut(),
                flags,
            );
            if req.is_null() {
                let _ = WinHttpCloseHandle(conn);
                return Err("WinHttpOpenRequest failed".to_string());
            }

            let bytes = body.as_bytes();
            let sent = WinHttpSendRequest(
                req,
                Some(&headers_w[..headers_w.len() - 1]), // sans NUL
                Some(bytes.as_ptr() as *const core::ffi::c_void),
                bytes.len() as u32,
                bytes.len() as u32,
                0,
            )
            .is_ok()
                && WinHttpReceiveResponse(req, std::ptr::null_mut()).is_ok();

            let out = if sent {
                let code = query_status_code(req).unwrap_or(0);
                let body = read_all(req);
                Ok((code, body))
            } else {
                Err("WinHttpSendRequest failed".to_string())
            };
            let _ = WinHttpCloseHandle(req);
            let _ = WinHttpCloseHandle(conn);
            out
        })();
        let _ = WinHttpCloseHandle(session);
        result
    }

    unsafe fn query_status_code(req: *mut core::ffi::c_void) -> Option<u32> {
        let mut code: u32 = 0;
        let mut len = std::mem::size_of::<u32>() as u32;
        let ok = WinHttpQueryHeaders(
            req,
            WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
            PCWSTR::null(),
            Some(&mut code as *mut u32 as *mut core::ffi::c_void),
            &mut len,
            std::ptr::null_mut(),
        )
        .is_ok();
        if ok {
            Some(code)
        } else {
            None
        }
    }

    unsafe fn read_all(req: *mut core::ffi::c_void) -> String {
        let mut data: Vec<u8> = Vec::new();
        let mut buf = [0u8; 8192];
        loop {
            let mut read: u32 = 0;
            if WinHttpReadData(
                req,
                buf.as_mut_ptr() as *mut core::ffi::c_void,
                buf.len() as u32,
                &mut read,
            )
            .is_err()
                || read == 0
            {
                break;
            }
            data.extend_from_slice(&buf[..read as usize]);
        }
        String::from_utf8_lossy(&data).into_owned()
    }

    // ---- modal nickname prompt ----

    struct PromptState {
        edit: HWND,
        result: Option<String>,
        done: bool,
    }

    const IDC_PROMPT_OK: usize = 100;
    const IDC_PROMPT_CANCEL: usize = 101;

    unsafe fn prompt_nickname(owner: HWND) -> Option<String> {
        let hinstance = GetModuleHandleW(None).ok()?;
        let class = w!("CuratorPrompt");
        let wc = WNDCLASSW {
            lpfnWndProc: Some(prompt_proc),
            hInstance: hinstance.into(),
            lpszClassName: class,
            hCursor: LoadCursorW(None, IDC_ARROW).unwrap_or_default(),
            hbrBackground: HBRUSH(6 as *mut core::ffi::c_void),
            ..Default::default()
        };
        RegisterClassW(&wc); // idempotent enough for a one-window app

        let mut ps = PromptState { edit: HWND::default(), result: None, done: false };
        let dlg = CreateWindowExW(
            WINDOW_EX_STYLE(0),
            class,
            w!("Submit build"),
            WS_POPUPWINDOW | WS_CAPTION | WS_VISIBLE,
            CW_USEDEFAULT,
            CW_USEDEFAULT,
            360,
            150,
            owner,
            None,
            hinstance,
            Some(&mut ps as *mut PromptState as *const core::ffi::c_void),
        )
        .ok()?;

        let _ = EnableWindow(owner, false);
        let mut msg = MSG::default();
        while !ps.done && GetMessageW(&mut msg, None, 0, 0).as_bool() {
            if !IsDialogMessageW(dlg, &msg).as_bool() {
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
        }
        let _ = EnableWindow(owner, true);
        let _ = SetForegroundWindow(owner);
        let _ = DestroyWindow(dlg);
        ps.result.take()
    }

    extern "system" fn prompt_proc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        unsafe {
            match msg {
                WM_CREATE => {
                    let cs = lparam.0 as *const CREATESTRUCTW;
                    let ps = (*cs).lpCreateParams as *mut PromptState;
                    SetWindowLongPtrW(hwnd, GWLP_USERDATA, ps as isize);
                    let hinst = (*cs).hInstance;
                    let _ = CreateWindowExW(
                        WINDOW_EX_STYLE(0),
                        w!("STATIC"),
                        w!("Nickname for attribution:"),
                        WS_CHILD | WS_VISIBLE,
                        12, 12, 320, 18, hwnd, None, hinst, None,
                    );
                    let edit = CreateWindowExW(
                        WINDOW_EX_STYLE(0),
                        w!("EDIT"),
                        PCWSTR::null(),
                        WS_CHILD | WS_VISIBLE | WS_BORDER | WINDOW_STYLE(ES_AUTOHSCROLL as u32),
                        12, 34, 320, 24, hwnd, None, hinst, None,
                    )
                    .unwrap_or_default();
                    let _ = CreateWindowExW(
                        WINDOW_EX_STYLE(0),
                        w!("BUTTON"),
                        w!("Submit"),
                        WS_CHILD | WS_VISIBLE | WINDOW_STYLE(BS_DEFPUSHBUTTON as u32),
                        160, 72, 80, 26, hwnd,
                        HMENU(IDC_PROMPT_OK as *mut core::ffi::c_void), hinst, None,
                    );
                    let _ = CreateWindowExW(
                        WINDOW_EX_STYLE(0),
                        w!("BUTTON"),
                        w!("Cancel"),
                        WS_CHILD | WS_VISIBLE,
                        252, 72, 80, 26, hwnd,
                        HMENU(IDC_PROMPT_CANCEL as *mut core::ffi::c_void), hinst, None,
                    );
                    if let Some(ps) = (ps as *mut PromptState).as_mut() {
                        ps.edit = edit;
                    }
                    LRESULT(0)
                }
                WM_COMMAND => {
                    let id = (wparam.0 & 0xffff) as usize;
                    let ps = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut PromptState;
                    if let Some(ps) = ps.as_mut() {
                        if id == IDC_PROMPT_OK {
                            ps.result = Some(read_edit_text(ps.edit));
                            ps.done = true;
                        } else if id == IDC_PROMPT_CANCEL {
                            ps.result = None;
                            ps.done = true;
                        }
                    }
                    LRESULT(0)
                }
                WM_CLOSE => {
                    let ps = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut PromptState;
                    if let Some(ps) = ps.as_mut() {
                        ps.done = true;
                    }
                    LRESULT(0)
                }
                _ => DefWindowProcW(hwnd, msg, wparam, lparam),
            }
        }
    }

    unsafe fn read_edit_text(edit: HWND) -> String {
        let len = GetWindowTextLengthW(edit);
        if len <= 0 {
            return String::new();
        }
        let mut buf = vec![0u16; len as usize + 1];
        let n = GetWindowTextW(edit, &mut buf);
        String::from_utf16_lossy(&buf[..n as usize])
    }

    /// Bridges core progress to the UI thread: queues an event and pokes the window.
    struct WinObserver {
        hwnd: isize,
        events: Arc<Mutex<VecDeque<UiEvent>>>,
        cancel: Arc<AtomicBool>,
    }

    impl ProgressObserver for WinObserver {
        fn on_event(&self, ev: Event) {
            let ui = match ev {
                Event::BatchItem { index, total, name } => UiEvent::Batch { index, total, name },
                Event::CounterOpen { id, label, total, .. } => UiEvent::Open { id, label, total },
                Event::Progress { id, count } => UiEvent::Progress { id, count },
                Event::CounterClose { id } => UiEvent::Close { id },
                Event::Message(text) => UiEvent::Message(text),
            };
            self.events.lock().unwrap().push_back(ui);
            unsafe {
                let _ = PostMessageW(
                    HWND(self.hwnd as *mut core::ffi::c_void),
                    WM_APP_PROGRESS,
                    WPARAM(0),
                    LPARAM(0),
                );
            }
        }

        fn is_cancelled(&self) -> bool {
            self.cancel.load(Ordering::SeqCst)
        }
    }
}
