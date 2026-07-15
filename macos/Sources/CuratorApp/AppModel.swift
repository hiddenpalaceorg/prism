import Foundation
import SwiftUI
import UniformTypeIdentifiers
import AppKit
import CuratorKit

/// A single live progress counter (image hashing, per-archive extraction, …).
struct CounterState: Identifiable {
    let id: UInt64
    var label: String
    var unit: String
    var total: Double?
    var count: Double = 0

    var fraction: Double? {
        guard let total, total > 0 else { return nil }
        return min(1, count / total)
    }
}

/// What document the viewer shows.
enum DocMode: String, CaseIterable, Identifiable {
    case xml = "XML"
    case json = "JSON"
    var id: String { rawValue }
}

/// Which detail-pane tab is showing. Defaults to `.overview` on load; selecting a file
/// in the sidebar switches to `.selection`. XML/JSON live under `.document` (opt-in).
enum DetailTab: Hashable {
    case overview, selection, assets, document, similar
}

/// An in-app preview of one text asset (never shell-opened — a `.sh`/`.bat`/`.js`
/// from an untrusted disc must not reach an app that might execute it) or of an
/// unidentified file's head snippet rendered as a hex dump.
struct AssetTextPreview: Identifiable {
    let id: String // asset sha256
    let name: String
    let text: String
    /// Caption under the preview (truncation / snippet notice), if any.
    let note: String?
}

/// Forwards UniFFI progress callbacks (delivered on a background thread) to a main-actor sink.
final class ProgressForwarder: ProgressListener, @unchecked Sendable {
    enum Update {
        case batch(index: UInt64, total: UInt64, name: String)
        case open(id: UInt64, label: String, unit: String, total: Double?)
        case progress(id: UInt64, count: Double)
        case close(id: UInt64)
        case message(String)
    }

    private let sink: @Sendable (Update) -> Void
    init(_ sink: @escaping @Sendable (Update) -> Void) { self.sink = sink }

    func onBatch(index: UInt64, total: UInt64, name: String) { sink(.batch(index: index, total: total, name: name)) }
    func onCounterOpen(id: UInt64, label: String, unit: String, total: Double?) { sink(.open(id: id, label: label, unit: unit, total: total)) }
    func onProgress(id: UInt64, count: Double) { sink(.progress(id: id, count: count)) }
    func onCounterClose(id: UInt64) { sink(.close(id: id)) }
    func onMessage(text: String) { sink(.message(text)) }
}

@MainActor
final class AppModel: ObservableObject {
    @Published var summary: AnalysisSummary?
    @Published var record: RecordDoc?
    @Published var detailTab: DetailTab = .overview
    @Published var rootNodes: [DiscNode] = []
    @Published var nodeIndex: [UUID: DiscNode] = [:]
    @Published var selection: UUID?
    @Published var isWorking = false
    @Published var status = "Open a disc image, container, or folder to analyze."
    @Published var counters: [CounterState] = []
    @Published var docMode: DocMode = .xml
    @Published var errorMessage: String?
    @Published var showingError = false
    @Published var libraryCount: UInt64 = 0
    @Published var recent: [LibraryEntry] = []

    // Library browser (searchable + sortable list of every analyzed build).
    @Published var libraryResults: [LibraryEntry] = []
    @Published var librarySearch = ""
    @Published var librarySystemFilter = ""        // "" = all systems
    @Published var librarySystems: [String] = []
    @Published var librarySort: LibrarySort = .date
    @Published var librarySortDescending = true
    /// Upper bound on rows pulled into the browser at once.
    private let libraryPageLimit: UInt32 = 10_000

    // Web service (read-only similarity + submit).
    @Published var similarity: SimilarityResponse?
    @Published var isQuerying = false
    @Published var serviceMessage: String?
    @Published var showingSubmitSheet = false

    // Asset viewer.
    @Published var assetPreview: AssetTextPreview?

    private let service = CuratorService()
    private var engine: Engine?
    private var cancelHandle: CancelHandle?
    /// True during a recursive folder import — see `apply(_:)` for why.
    private var isImporting = false
    /// Dedicated queue for the blocking synchronous FFI `analyze` call, so it
    /// doesn't occupy a Swift-concurrency cooperative-pool thread.
    private let analysisQueue = DispatchQueue(label: "curator.analysis")

    var selectedNode: DiscNode? { selection.flatMap { nodeIndex[$0] } }

    /// Resolve the adapter: explicit env override → embedded adapter → dev dir.
    private func resolveAdapter() -> (dir: String?, bin: String?) {
        let env = ProcessInfo.processInfo.environment
        if let bin = env["CURATOR_ADAPTER_BIN"] { return (nil, bin) }
        // Shipped app: Curator.app/Contents/Resources/adapter/curator-adapter
        if let res = Bundle.main.resourceURL {
            let launcher = res.appendingPathComponent("adapter/curator-adapter")
            if FileManager.default.isExecutableFile(atPath: launcher.path) {
                return (nil, launcher.path)
            }
        }
        return (env["CURATOR_ADAPTER_DIR"] ?? "../ps2exe-adapter", nil)
    }

    private func makeEngine() throws -> Engine {
        if let engine { return engine }
        let (dir, bin) = resolveAdapter()
        let e = try Engine(
            adapterDir: dir,
            adapterBin: bin,
            dataDir: ProcessInfo.processInfo.environment["CURATOR_DATA_DIR"]
        )
        engine = e
        libraryCount = (try? e.librarySize()) ?? 0
        return e
    }

    func refreshLibraryCount() {
        libraryCount = (try? engine?.librarySize()) ?? libraryCount
        recent = (try? engine?.recentBuilds(limit: 25)) ?? recent
    }

    /// Build the engine, then load the systems filter + current result page.
    /// Safe to call repeatedly (e.g. each time the browser appears).
    func loadLibraryAtLaunch() {
        guard (try? makeEngine()) != nil else { return }
        librarySystems = (try? engine?.librarySystems()) ?? librarySystems
        refreshLibrary()
    }

    /// Re-run the library query for the current search / filter / sort.
    func refreshLibrary() {
        guard let e = try? makeEngine() else { return }
        let q = librarySearch.trimmingCharacters(in: .whitespacesAndNewlines)
        libraryResults = (try? e.searchLibrary(
            search: q.isEmpty ? nil : q,
            system: librarySystemFilter.isEmpty ? nil : librarySystemFilter,
            sort: librarySort,
            descending: librarySortDescending,
            limit: libraryPageLimit,
            offset: 0
        )) ?? []
    }

    /// Header click: same column flips direction; a new column resets to a sensible
    /// default (text ascending, counts/dates descending).
    func sortLibrary(by column: LibrarySort) {
        if librarySort == column {
            librarySortDescending.toggle()
        } else {
            librarySort = column
            librarySortDescending = !(column == .name || column == .system)
        }
        refreshLibrary()
    }

    /// Populate the recent list at launch (builds the engine lazily).
    func loadRecentAtLaunch() {
        guard recent.isEmpty, engine == nil else { return }
        if let e = try? makeEngine() { recent = (try? e.recentBuilds(limit: 25)) ?? [] }
    }

    /// Reopen a stored build from cache (no re-analysis).
    func openRecent(sha256: String) {
        // No `guard !isWorking`: loadBuild uses the reader, so opening works during an
        // import. Use `show` (not `finish`) so it doesn't clear the import's state.
        do {
            guard let e = try? makeEngine(), let summary = try e.loadBuild(sha256: sha256) else {
                status = "Build not in cache anymore."
                return
            }
            errorMessage = nil
            show(summary: summary)
            if !isWorking {
                status = "\(summary.fromCache ? "Loaded from cache" : "Analyzed") — \(summary.system), \(summary.fileCount) files, \(humanSize(summary.totalSize))."
            }
        } catch {
            errorMessage = (error as? LocalizedError)?.errorDescription ?? "\(error)"
        }
    }

    func analyze(url: URL) {
        guard !isWorking else { return }
        isWorking = true
        errorMessage = nil
        counters = []
        status = "Analyzing \(url.lastPathComponent)…"
        let cancel = CancelHandle()
        cancelHandle = cancel

        let forwarder = ProgressForwarder { [weak self] update in
            Task { @MainActor in self?.apply(update) }
        }
        let path = url.path

        Task.detached(priority: .userInitiated) { [weak self] in
            guard let self else { return }
            do {
                let engine = try await MainActor.run { try self.makeEngine() }
                // Run the blocking FFI call on a dedicated queue, off the
                // cooperative pool, then hop the result back to the main actor.
                let summary: AnalysisSummary = try await withCheckedThrowingContinuation { continuation in
                    self.analysisQueue.async {
                        do {
                            let summary = try engine.analyze(path: path, listener: forwarder, cancel: cancel)
                            continuation.resume(returning: summary)
                        } catch {
                            continuation.resume(throwing: error)
                        }
                    }
                }
                await MainActor.run { self.finish(summary: summary) }
            } catch CuratorError.Cancelled {
                await MainActor.run { self.fail("Cancelled.") }
            } catch let CuratorError.Failed(message) {
                await MainActor.run { self.fail(message) }
            } catch {
                await MainActor.run { self.fail("\(error)") }
            }
        }
    }

    func cancel() {
        cancelHandle?.cancel()
        status = "Cancelling…"
    }

    /// Surface a drag-and-drop resolution failure to the user.
    func reportDropFailure(_ message: String) {
        errorMessage = message
        status = "Drop failed."
    }

    // MARK: - Web service actions

    /// Query the web service for builds similar to the loaded one.
    func findSimilar() {
        guard let summary, !isQuerying else { return }
        let json = summary.json
        isQuerying = true
        similarity = nil
        serviceMessage = "Querying \(service.baseURL.host ?? "service")…"
        Task {
            do {
                let resp = try await service.findSimilar(recordJSON: json)
                similarity = resp
                serviceMessage = resp.isEmpty
                    ? "No similar builds found."
                    : "Neighbors across \(resp.sections.count) tier(s)."
            } catch {
                serviceMessage = (error as? LocalizedError)?.errorDescription ?? "\(error)"
            }
            isQuerying = false
        }
    }

    /// Submit the loaded build to the moderation queue under `nickname`, then
    /// upload whichever of its asset blobs the server reports missing.
    func submit(nickname: String) {
        guard let summary, !isQuerying else { return }
        let json = summary.json
        let nick = nickname.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !nick.isEmpty else { return }
        isQuerying = true
        serviceMessage = "Submitting…"
        Task {
            do {
                let r = try await service.submit(recordJSON: json, nickname: nick)
                let assetNote = await uploadMissingAssets(for: summary)
                let acceptNote = await acceptSubmission(sha256: r.sha256)
                serviceMessage = "Submitted \(r.sha256.prefix(12))… — \(r.status).\(assetNote)\(acceptNote)"
            } catch {
                serviceMessage = (error as? LocalizedError)?.errorDescription ?? "\(error)"
            }
            isQuerying = false
        }
    }

    /// Upload the build's asset blobs that the server lacks and we hold locally.
    /// Returns a status suffix for the submit message ("" when moot). Upload
    /// failures degrade to a note — the record submission already succeeded.
    private func uploadMissingAssets(for summary: AnalysisSummary) async -> String {
        guard let assets = summary.assets, !assets.isEmpty else { return "" }
        var local: [String: String] = [:] // asset sha256 → blob path
        for a in assets where a.blobPath != nil { local[a.sha256] = a.blobPath }
        do {
            let missing = try await service.missingAssets(buildSha: summary.sha256)
            if missing.isEmpty { return " Assets already on server." }
            let todo = missing.filter { local[$0] != nil }
            var done = 0
            for sha in todo {
                serviceMessage = "Uploading assets \(done + 1)/\(todo.count)…"
                guard let blob = local[sha] else { continue }
                try await service.uploadAsset(
                    buildSha: summary.sha256,
                    assetSha: sha,
                    fileURL: URL(fileURLWithPath: blob)
                )
                done += 1
            }
            let unavailable = missing.count - todo.count
            var note = " Uploaded \(done) asset blob\(done == 1 ? "" : "s")"
            if unavailable > 0 { note += " (\(unavailable) not in the local store)" }
            return note + "."
        } catch {
            let detail = (error as? LocalizedError)?.errorDescription ?? "\(error)"
            return " Asset upload failed: \(detail)"
        }
    }

    /// With a moderation token configured, finish the job: accept the submission
    /// so it replaces the live build (assets are uploaded first). Returns a status
    /// suffix ("" without a token); a failure degrades to a note — the submission
    /// stays queued for manual moderation.
    private func acceptSubmission(sha256: String) async -> String {
        guard service.moderationToken != nil else { return "" }
        do {
            try await service.accept(buildSha: sha256)
            return " Accepted — live build updated."
        } catch {
            let detail = (error as? LocalizedError)?.errorDescription ?? "\(error)"
            return " Accept failed: \(detail)"
        }
    }

    // MARK: - Asset viewer

    /// Open one extracted asset. Media kinds go to the default app via a temp
    /// copy carrying the original filename (blobs are extensionless, so the
    /// store path alone can't pick a handler). Text and source kinds preview
    /// in-app only: shell-opening a `.sh`/`.bat`/`.js` from an untrusted disc
    /// could hand it to something that executes it. Binary kinds (unidentified
    /// files' head snippets) preview in-app as a hex dump.
    func openAsset(_ asset: AssetInfo) {
        guard let blob = asset.blobPath else {
            status = "Asset not in the local store — re-analyze the image to extract it."
            return
        }
        if asset.kind == "binary" {
            previewHexAsset(asset, blob: blob)
            return
        }
        if asset.kind == "text" || asset.kind == "source" {
            previewTextAsset(asset, blob: blob)
            return
        }
        do {
            let url = try materializeAsset(asset, blob: blob)
            if !NSWorkspace.shared.open(url) {
                status = "No application could open \(url.lastPathComponent)."
            }
        } catch {
            status = "Couldn't open asset: \(error.localizedDescription)"
        }
    }

    /// Show a text asset in the in-app preview sheet (display capped at 256 KB).
    private func previewTextAsset(_ asset: AssetInfo, blob: String) {
        let capBytes = 256 * 1024
        guard let fh = FileHandle(forReadingAtPath: blob) else {
            status = "Couldn't read asset from the local store."
            return
        }
        defer { try? fh.close() }
        let data = (try? fh.read(upToCount: capBytes)) ?? Data()
        let text = String(decoding: data, as: UTF8.self)
            .replacingOccurrences(of: "\0", with: "")
            .replacingOccurrences(of: "\r\n", with: "\n")
        assetPreview = AssetTextPreview(
            id: asset.sha256,
            name: (asset.path as NSString).lastPathComponent,
            text: text,
            note: asset.size > UInt64(capBytes) ? "Preview truncated to the first 256 KB." : nil
        )
    }

    /// The analyzer stores only this much of an unidentified file (viewable.py
    /// SNIPPET_BYTES) — a blob this long is (almost surely) a truncated head.
    private static let snippetBytes = 2048

    /// Show an unidentified file's stored head snippet as an xxd-style hex dump.
    private func previewHexAsset(_ asset: AssetInfo, blob: String) {
        guard let data = FileManager.default.contents(atPath: blob) else {
            status = "Couldn't read asset from the local store."
            return
        }
        assetPreview = AssetTextPreview(
            id: asset.sha256,
            name: (asset.path as NSString).lastPathComponent,
            text: hexDump(data),
            note: asset.size >= UInt64(Self.snippetBytes)
                ? "Unidentified file — only its first 2 KB is stored." : nil
        )
    }

    /// Classic xxd layout: 8-hex offset, 16 bytes as 2-byte groups, ASCII gutter.
    /// Rendered at display time from the raw stored bytes, so the layout can
    /// change without re-analyzing anything.
    private func hexDump(_ data: Data) -> String {
        var out = ""
        var offset = 0
        while offset < data.count {
            let end = min(offset + 16, data.count)
            out += String(format: "%08x: ", offset)
            for j in 0..<16 {
                out += offset + j < end ? String(format: "%02x", data[data.startIndex + offset + j]) : "  "
                if j % 2 == 1 { out += " " }
            }
            out += " "
            for i in offset..<end {
                let b = data[data.startIndex + i]
                out.append(b >= 0x20 && b < 0x7f ? Character(UnicodeScalar(b)) : ".")
            }
            out += "\n"
            offset = end
        }
        return out
    }

    /// Copy a blob into a per-asset temp dir under its original filename so
    /// Launch Services can pick the right app. Content-addressed, so an
    /// existing copy is reused.
    private func materializeAsset(_ asset: AssetInfo, blob: String) throws -> URL {
        let base = (asset.path as NSString).lastPathComponent
            .replacingOccurrences(of: ":", with: "_")
        let name = base.isEmpty ? asset.sha256 : base
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("curator-assets", isDirectory: true)
            .appendingPathComponent(asset.sha256, isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let dest = dir.appendingPathComponent(name)
        if !FileManager.default.fileExists(atPath: dest.path) {
            try FileManager.default.copyItem(at: URL(fileURLWithPath: blob), to: dest)
        }
        return dest
    }

    /// Open a build's detail page in the web library in the default browser.
    func openInWeb(sha256: String) {
        let url = service.baseURL.appendingPathComponent("build").appendingPathComponent(sha256)
        NSWorkspace.shared.open(url)
    }

    /// Present the native open panel (files or folders) and analyze the choice.
    func openDialog() {
        guard !isWorking else { return }
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = true
        panel.allowsMultipleSelection = false
        panel.prompt = "Open"
        if panel.runModal() == .OK, let url = panel.url {
            open(url: url)
        }
    }

    /// Analyze a single file, or a folder that holds one build split across files
    /// (a multi-track dump); recursively import any other dropped/chosen folder.
    func open(url: URL) {
        var isDir: ObjCBool = false
        FileManager.default.fileExists(atPath: url.path, isDirectory: &isDir)
        if isDir.boolValue && !folderIsSingleBuild(root: url.path) {
            importFolder(url: url)
        } else {
            analyze(url: url)
        }
    }

    /// Present a folder picker and force the choice through as ONE build (a split
    /// multi-track dump), regardless of the single-build heuristic.
    func openFolderAsBuildDialog() {
        guard !isWorking else { return }
        let panel = NSOpenPanel()
        panel.canChooseFiles = false
        panel.canChooseDirectories = true
        panel.allowsMultipleSelection = false
        panel.prompt = "Open as Build"
        if panel.runModal() == .OK, let url = panel.url {
            analyze(url: url)
        }
    }

    /// Recursively import every file under `url`: analyze each, skipping any that
    /// don't parse as a disc. Runs off the main actor with per-item progress.
    func importFolder(url: URL) {
        guard !isWorking else { return }
        isWorking = true
        isImporting = true
        errorMessage = nil
        counters = []
        summary = nil // show the (live-updating) library browser while importing
        status = "Scanning \(url.lastPathComponent)…"
        let cancel = CancelHandle()
        cancelHandle = cancel
        let forwarder = ProgressForwarder { [weak self] update in
            Task { @MainActor in self?.apply(update) }
        }
        let root = url.path

        Task.detached(priority: .userInitiated) { [weak self] in
            guard let self else { return }
            do {
                let engine = try await MainActor.run { try self.makeEngine() }
                let files = (try? engine.listFiles(root: root)) ?? []
                var imported = 0, skipped = 0, cancelled = false
                for (i, path) in files.enumerated() {
                    if cancel.isCancelled() { cancelled = true; break }
                    await MainActor.run {
                        self.status = "Importing \(i + 1)/\(files.count): \((path as NSString).lastPathComponent)"
                    }
                    do {
                        _ = try await withCheckedThrowingContinuation { (cont: CheckedContinuation<AnalysisSummary, Error>) in
                            self.analysisQueue.async {
                                do { cont.resume(returning: try engine.analyze(path: path, listener: forwarder, cancel: cancel)) }
                                catch { cont.resume(throwing: error) }
                            }
                        }
                        imported += 1
                        // Live-refresh the (non-modal) browser as items land. Reads use a
                        // separate DB connection, so this never blocks on the import writer.
                        if imported % 5 == 0 {
                            await MainActor.run { self.refreshLibrary() }
                        }
                    } catch CuratorError.Cancelled {
                        cancelled = true
                        break
                    } catch {
                        skipped += 1 // unsupported/unreadable — skip and continue
                    }
                }
                let summary = cancelled
                    ? "Import cancelled — \(imported) imported, \(skipped) skipped."
                    : "Imported \(imported), skipped \(skipped) unsupported."
                await MainActor.run {
                    self.isWorking = false
                    self.isImporting = false
                    self.counters = []
                    self.status = summary
                    self.loadLibraryAtLaunch() // refresh systems + results
                }
            } catch {
                await MainActor.run {
                    self.isWorking = false
                    self.isImporting = false
                    self.status = "Import failed."
                    self.errorMessage = (error as? LocalizedError)?.errorDescription ?? "\(error)"
                    self.showingError = true
                }
            }
        }
    }

    /// Export the whole local library to a single `.zip` to copy to the server
    /// machine and ingest. The export runs off the main thread (a big library is
    /// slow); the FFI call goes on the same dedicated queue as `analyze`.
    func exportLibrary() {
        guard !isWorking else { return }
        let panel = NSSavePanel()
        panel.title = "Export Library for Upload"
        panel.prompt = "Export"
        panel.nameFieldStringValue = "collection.curator.zip"
        panel.allowedContentTypes = [.zip]
        guard panel.runModal() == .OK, let url = panel.url else { return }
        let outPath = url.path

        isWorking = true
        errorMessage = nil
        status = "Exporting library…"

        Task.detached(priority: .userInitiated) { [weak self] in
            guard let self else { return }
            do {
                let engine = try await MainActor.run { try self.makeEngine() }
                let count: UInt64 = try await withCheckedThrowingContinuation { continuation in
                    self.analysisQueue.async {
                        do {
                            continuation.resume(returning: try engine.exportBundle(outPath: outPath))
                        } catch {
                            continuation.resume(throwing: error)
                        }
                    }
                }
                await MainActor.run {
                    self.isWorking = false
                    self.status = count == 0
                        ? "Library is empty — analyze a disc first."
                        : "Exported \(count) builds → \(outPath)"
                }
            } catch {
                await MainActor.run {
                    self.isWorking = false
                    self.status = "Export failed."
                    self.errorMessage = (error as? LocalizedError)?.errorDescription ?? "\(error)"
                    self.showingError = true
                }
            }
        }
    }

    // MARK: - main-actor sinks

    private func apply(_ update: ProgressForwarder.Update) {
        switch update {
        case let .batch(index, total, name):
            status = "Item \(index + 1) of \(total): \((name as NSString).lastPathComponent)"
        case let .open(id, label, unit, total):
            counters.removeAll { $0.id == id }
            counters.append(CounterState(id: id, label: label, unit: unit, total: total))
        case let .progress(id, count):
            if let i = counters.firstIndex(where: { $0.id == id }) { counters[i].count = count }
        case let .close(id):
            counters.removeAll { $0.id == id }
        case let .message(text):
            // During a batch import, keep the "Importing i/N" line (counters still
            // show per-file hashing); a single analyze surfaces the message.
            if !isImporting { status = text }
        }
    }

    /// Display a build in the detail pane. Pure view state — does NOT touch
    /// isWorking/cancelHandle, so it's safe to call while an import runs.
    private func show(summary: AnalysisSummary) {
        self.summary = summary
        record = RecordDoc.decode(summary.json)
        detailTab = .overview
        rootNodes = summary.tree.map(DiscNode.init)
        var idx: [UUID: DiscNode] = [:]
        rootNodes.forEach { $0.index(into: &idx) }
        nodeIndex = idx
        selection = nil
        similarity = nil
        serviceMessage = nil
    }

    private func finish(summary: AnalysisSummary) {
        show(summary: summary)
        counters = []
        isWorking = false
        cancelHandle = nil
        status = "\(summary.fromCache ? "Loaded from cache" : "Analyzed") — \(summary.system), \(summary.fileCount) files, \(humanSize(summary.totalSize))."
        refreshLibraryCount()
    }

    private func fail(_ message: String) {
        isWorking = false
        cancelHandle = nil
        counters = []
        if message == "Cancelled." {
            status = "Cancelled."
        } else {
            errorMessage = message
            status = "Failed."
            // Adapter failures are often long multi-line tracebacks; surface them in a
            // dismissable dialog rather than only as a truncated status-bar line.
            showingError = true
        }
    }
}
