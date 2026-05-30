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
    use windows::Win32::System::Com::CoTaskMemFree;
    use windows::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows::Win32::UI::Controls::Dialogs::{GetOpenFileNameW, OFN_FILEMUSTEXIST, OFN_PATHMUSTEXIST, OPENFILENAMEW};
    use windows::Win32::UI::Controls::{
        InitCommonControlsEx, ICC_BAR_CLASSES, ICC_PROGRESS_CLASS, ICC_TREEVIEW_CLASSES,
        INITCOMMONCONTROLSEX, PBM_SETPOS, PBM_SETRANGE32, TVINSERTSTRUCTW, TVINSERTSTRUCTW_0,
        TVITEMW, TVIF_TEXT, TVI_LAST, TVI_ROOT, TVM_DELETEITEM, TVM_INSERTITEMW,
        TVS_HASBUTTONS, TVS_HASLINES, TVS_LINESATROOT,
    };
    use windows::Win32::UI::Shell::{SHBrowseForFolderW, SHGetPathFromIDListW, BROWSEINFOW, BIF_RETURNONLYFSDIRS};
    use windows::Win32::UI::WindowsAndMessaging::*;

    // ---- ids & custom messages ----
    const IDM_OPEN: usize = 1;
    const IDM_OPEN_FOLDER: usize = 2;
    const IDM_CANCEL: usize = 3;
    const IDM_EXIT: usize = 4;

    const WM_APP_PROGRESS: u32 = WM_APP + 1;
    const WM_APP_DONE: u32 = WM_APP + 2;

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
    }

    /// Construction config passed through `CreateWindowExW`'s lpParam.
    struct InitConfig {
        adapter: AdapterCommand,
        data_dir: Option<PathBuf>,
    }

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
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

            // Dev defaults; a shipped build resolves a bundled adapter next to the exe.
            let init = Box::new(InitConfig {
                adapter: AdapterCommand::uv("ps2exe-adapter"),
                data_dir: None,
            });

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
                WM_APP_PROGRESS => {
                    drain_progress(hwnd);
                    LRESULT(0)
                }
                WM_APP_DONE => {
                    on_done(hwnd, lparam);
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

        build_menu(hwnd);

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
        });
        SetWindowLongPtrW(hwnd, GWLP_USERDATA, Box::into_raw(st) as isize);

        set_status(hwnd, "Open a disc image, container, or folder to analyze.");
        if let Some(st) = state(hwnd) {
            layout(hwnd, st);
        }
    }

    unsafe fn build_menu(hwnd: HWND) {
        let menu = CreateMenu().unwrap_or_default();
        let file = CreatePopupMenu().unwrap_or_default();
        let _ = AppendMenuW(file, MF_STRING, IDM_OPEN, w!("&Open Image…\tCtrl+O"));
        let _ = AppendMenuW(file, MF_STRING, IDM_OPEN_FOLDER, w!("Open &Folder…"));
        let _ = AppendMenuW(file, MF_SEPARATOR, 0, PCWSTR::null());
        let _ = AppendMenuW(file, MF_STRING, IDM_EXIT, w!("E&xit"));
        let analysis = CreatePopupMenu().unwrap_or_default();
        let _ = AppendMenuW(analysis, MF_STRING, IDM_CANCEL, w!("&Cancel"));
        let _ = AppendMenuW(menu, MF_POPUP, file.0 as usize, w!("&File"));
        let _ = AppendMenuW(menu, MF_POPUP, analysis.0 as usize, w!("&Analysis"));
        let _ = SetMenu(hwnd, menu);
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
            IDM_EXIT => {
                let _ = DestroyWindow(hwnd);
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
            Some(String::from_utf16_lossy(&buf).trim_end_matches('\0').to_string())
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
                Ok(AnalysisDone { record: analysis.record, xml, from_cache: analysis.from_cache })
            })();

            let boxed = Box::new(outcome);
            let _ = PostMessageW(
                HWND(hwnd_i as *mut core::ffi::c_void),
                WM_APP_DONE,
                WPARAM(0),
                LPARAM(Box::into_raw(boxed) as isize),
            );
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
        let Some(st) = state(hwnd) else { return };
        st.working = false;
        let _ = SendMessageW(st.progress, PBM_SETPOS, WPARAM(0), LPARAM(0));

        match outcome {
            Ok(done) => {
                populate_tree(st.tree, &done.record);
                let body = done.xml.replace('\n', "\r\n");
                let wbody = wide(&body);
                let _ = SetWindowTextW(st.edit, PCWSTR(wbody.as_ptr()));
                let tag = if done.from_cache { "cached" } else { "analyzed" };
                set_status(
                    hwnd,
                    &format!(
                        "[{tag}] {} — {}, {} files",
                        done.record.image.sha256,
                        done.record.info.system,
                        done.record.structural.file_count
                    ),
                );
            }
            Err(msg) => {
                set_status(hwnd, &format!("Failed: {msg}"));
            }
        }
    }

    unsafe fn populate_tree(tree: HWND, record: &BuildRecord) {
        let _ = SendMessageW(tree, TVM_DELETEITEM, WPARAM(0), LPARAM(TVI_ROOT.0));
        for node in &record.contents {
            insert_node(tree, TVI_ROOT, node);
        }
    }

    unsafe fn insert_node(tree: HWND, parent: windows::Win32::UI::Controls::HTREEITEM, node: &Node) {
        let mut label = wide(node.name());
        let mut item = TVITEMW::default();
        item.mask = TVIF_TEXT;
        item.pszText = PWSTR(label.as_mut_ptr());
        let ins = TVINSERTSTRUCTW {
            hParent: parent,
            hInsertAfter: TVI_LAST,
            Anonymous: TVINSERTSTRUCTW_0 { item },
        };
        let lr = SendMessageW(tree, TVM_INSERTITEMW, WPARAM(0), LPARAM(&ins as *const _ as isize));
        let handle = windows::Win32::UI::Controls::HTREEITEM(lr.0);
        if let Node::Dir { children, .. } = node {
            for child in children {
                insert_node(tree, handle, child);
            }
        }
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
