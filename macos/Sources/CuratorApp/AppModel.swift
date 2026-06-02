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
    case overview, selection, document, similar
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

    private let service = CuratorService()
    private var engine: Engine?
    private var cancelHandle: CancelHandle?
    /// Dedicated queue for the blocking synchronous FFI `analyze` call, so it
    /// doesn't occupy a Swift-concurrency cooperative-pool thread.
    private let analysisQueue = DispatchQueue(label: "curator.analysis")

    var selectedNode: DiscNode? { selection.flatMap { nodeIndex[$0] } }

    /// Resolve the adapter: explicit env override → embedded Phase-2 bundle → dev dir.
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
        guard !isWorking else { return }
        do {
            guard let e = try? makeEngine(), let summary = try e.loadBuild(sha256: sha256) else {
                status = "Build not in cache anymore."
                return
            }
            errorMessage = nil
            finish(summary: summary)
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

    /// Submit the loaded build to the moderation queue under `nickname`.
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
                serviceMessage = "Submitted \(r.sha256.prefix(12))… — \(r.status)."
            } catch {
                serviceMessage = (error as? LocalizedError)?.errorDescription ?? "\(error)"
            }
            isQuerying = false
        }
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
        panel.prompt = "Analyze"
        if panel.runModal() == .OK, let url = panel.url {
            analyze(url: url)
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
            status = text
        }
    }

    private func finish(summary: AnalysisSummary) {
        self.summary = summary
        record = RecordDoc.decode(summary.json)
        detailTab = .overview
        rootNodes = summary.tree.map(DiscNode.init)
        var idx: [UUID: DiscNode] = [:]
        rootNodes.forEach { $0.index(into: &idx) }
        nodeIndex = idx
        selection = nil
        counters = []
        isWorking = false
        cancelHandle = nil
        similarity = nil
        serviceMessage = nil
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
