import SwiftUI
import UniformTypeIdentifiers
import CuratorKit

struct ContentView: View {
    @EnvironmentObject var model: AppModel

    var body: some View {
        NavigationSplitView {
            SidebarView()
                .navigationSplitViewColumnWidth(min: 220, ideal: 300)
        } detail: {
            DetailView()
        }
        .onAppear { model.loadLibraryAtLaunch() }
        .onDrop(of: [UTType.fileURL], isTargeted: nil) { providers in
            guard !model.isWorking, let provider = providers.first else { return false }
            provider.loadItem(forTypeIdentifier: UTType.fileURL.identifier) { item, error in
                if let error {
                    Task { @MainActor in model.reportDropFailure("Couldn't read the dropped item: \(error.localizedDescription)") }
                    return
                }
                guard let data = item as? Data,
                      let url = URL(dataRepresentation: data, relativeTo: nil) else {
                    Task { @MainActor in model.reportDropFailure("Couldn't resolve the dropped item as a file.") }
                    return
                }
                Task { @MainActor in model.open(url: url) }
            }
            return true
        }
        .toolbar {
            ToolbarItemGroup {
                Button { model.openDialog() } label: { Label("Open", systemImage: "folder") }
                    .disabled(model.isWorking)
                if model.isWorking {
                    Button(role: .cancel) { model.cancel() } label: { Label("Cancel", systemImage: "stop.circle") }
                }
                if model.summary != nil {
                    Button { model.findSimilar() } label: { Label("Find Similar", systemImage: "sparkle.magnifyingglass") }
                        .disabled(model.isQuerying)
                    Button { model.showingSubmitSheet = true } label: { Label("Submit", systemImage: "square.and.arrow.up") }
                        .disabled(model.isQuerying)
                }
            }
        }
        .safeAreaInset(edge: .bottom) { StatusBar() }
        .sheet(isPresented: $model.showingSubmitSheet) { SubmitSheet() }
        .sheet(isPresented: $model.showingError) { ErrorSheet() }
        .sheet(item: $model.assetPreview) { AssetTextSheet(preview: $0) }
        .onChange(of: model.selection) { sel in
            // Clicking a file in the sidebar surfaces its metadata table.
            if sel != nil { model.detailTab = .selection }
        }
    }
}

// MARK: - Error sheet (selectable + copyable)

/// Adapter failures are often long multi-line tracebacks. A sheet with selectable,
/// scrollable text (plus a Copy button) lets the user grab the message — unlike a
/// plain `.alert`, whose text can't be selected.
struct ErrorSheet: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        let message = model.errorMessage ?? "An unknown error occurred."
        VStack(alignment: .leading, spacing: 12) {
            Label("Analysis failed", systemImage: "exclamationmark.triangle.fill")
                .font(.headline)
                .foregroundStyle(.red)
            ScrollView {
                Text(message)
                    .font(.system(.callout, design: .monospaced))
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .frame(minHeight: 120, maxHeight: 360)
            .padding(8)
            .background(.quaternary, in: RoundedRectangle(cornerRadius: 6))
            HStack {
                Spacer()
                Button("Copy") {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(message, forType: .string)
                }
                Button("Close") { dismiss() }
                    .keyboardShortcut(.defaultAction)
            }
        }
        .padding(16)
        .frame(width: 520)
    }
}

// MARK: - Sidebar (file tree)

struct SidebarView: View {
    @EnvironmentObject var model: AppModel

    var body: some View {
        Group {
            if !model.rootNodes.isEmpty {
                List(selection: $model.selection) {
                    ForEach(model.rootNodes) { root in
                        OutlineGroup(root, children: \.children) { node in
                            Label(node.name, systemImage: node.isDir ? "folder" : "doc")
                                .tag(node.id)
                        }
                    }
                }
            } else {
                ContentUnavailableViewCompat(
                    title: "No image loaded",
                    systemImage: "opticaldisc",
                    message: "Browse the library on the right, or open — or drag in — a disc image, container, or folder."
                )
            }
        }
    }
}

// MARK: - Library browser (searchable + sortable list of every analyzed build)

/// Fixed column widths shared by the header and rows so they line up. The title
/// column flexes to fill the rest.
private enum LibraryCol {
    static let system: CGFloat = 130
    static let files: CGFloat = 64
    static let size: CGFloat = 88
    static let date: CGFloat = 130
}

struct LibraryBrowser: View {
    @EnvironmentObject var model: AppModel

    private var filtering: Bool { !model.librarySearch.isEmpty || !model.librarySystemFilter.isEmpty }

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                Image(systemName: "magnifyingglass").foregroundStyle(.secondary)
                TextField("Search title or system", text: $model.librarySearch)
                    .textFieldStyle(.plain)
                    .onChange(of: model.librarySearch) { _ in model.refreshLibrary() }
                Divider().frame(height: 16)
                Picker("", selection: $model.librarySystemFilter) {
                    Text("All systems").tag("")
                    ForEach(model.librarySystems, id: \.self) { Text($0).tag($0) }
                }
                .labelsHidden()
                .frame(width: 180)
                .onChange(of: model.librarySystemFilter) { _ in model.refreshLibrary() }
            }
            .padding(8)
            Divider()
            LibraryHeader()
            Divider()
            if model.libraryResults.isEmpty {
                Spacer()
                ContentUnavailableViewCompat(
                    title: filtering ? "No matches" : "Library is empty",
                    systemImage: "tray",
                    message: filtering
                        ? "Try a different search or system filter."
                        : "Analyze or import discs to populate the library."
                )
                Spacer()
            } else {
                ScrollView {
                    LazyVStack(spacing: 0) {
                        ForEach(model.libraryResults, id: \.sha256) { e in
                            Button { model.openRecent(sha256: e.sha256) } label: {
                                LibraryRow(entry: e)
                            }
                            .buttonStyle(.plain)
                            Divider()
                        }
                    }
                }
            }
            HStack {
                Text("\(model.libraryResults.count) build\(model.libraryResults.count == 1 ? "" : "s")")
                    .font(.caption).foregroundStyle(.secondary)
                Spacer()
            }
            .padding(.horizontal, 12).padding(.vertical, 4)
        }
        .onAppear { model.loadLibraryAtLaunch() }
    }
}

struct LibraryHeader: View {
    @EnvironmentObject var model: AppModel

    var body: some View {
        HStack(spacing: 12) {
            sortButton("Title", .name).frame(maxWidth: .infinity, alignment: .leading)
            sortButton("System", .system).frame(width: LibraryCol.system, alignment: .leading)
            sortButton("Files", .files).frame(width: LibraryCol.files, alignment: .trailing)
            sortButton("Size", .size).frame(width: LibraryCol.size, alignment: .trailing)
            sortButton("Analyzed", .date).frame(width: LibraryCol.date, alignment: .trailing)
        }
        .font(.caption.bold())
        .foregroundStyle(.secondary)
        .padding(.horizontal, 12).padding(.vertical, 6)
    }

    @ViewBuilder
    private func sortButton(_ label: String, _ column: LibrarySort) -> some View {
        Button { model.sortLibrary(by: column) } label: {
            HStack(spacing: 2) {
                Text(label)
                if model.librarySort == column {
                    Image(systemName: model.librarySortDescending ? "chevron.down" : "chevron.up")
                        .font(.system(size: 8, weight: .bold))
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

struct LibraryRow: View {
    let entry: LibraryEntry

    var body: some View {
        HStack(spacing: 12) {
            Text(entry.name).lineLimit(1).truncationMode(.middle)
                .frame(maxWidth: .infinity, alignment: .leading)
            Text(entry.system).foregroundStyle(.secondary)
                .frame(width: LibraryCol.system, alignment: .leading)
            Text("\(entry.fileCount)").foregroundStyle(.secondary).monospacedDigit()
                .frame(width: LibraryCol.files, alignment: .trailing)
            Text(humanSize(entry.totalSize)).foregroundStyle(.secondary).monospacedDigit()
                .frame(width: LibraryCol.size, alignment: .trailing)
            Text(relativeDate(entry.analyzedAt)).foregroundStyle(.secondary)
                .frame(width: LibraryCol.date, alignment: .trailing)
        }
        .lineLimit(1)
        .padding(.horizontal, 12).padding(.vertical, 5)
        .contentShape(Rectangle())
    }
}

/// Unix seconds → a short relative string like "3d ago".
func relativeDate(_ unix: Int64) -> String {
    let formatter = RelativeDateTimeFormatter()
    formatter.unitsStyle = .abbreviated
    return formatter.localizedString(for: Date(timeIntervalSince1970: TimeInterval(unix)), relativeTo: Date())
}

// MARK: - Detail pane

struct DetailView: View {
    @EnvironmentObject var model: AppModel

    var body: some View {
        VStack(spacing: 0) {
            if let summary = model.summary {
                HeaderCard(summary: summary)
                Divider()
                TabView(selection: $model.detailTab) {
                    BuildOverview(summary: summary, record: model.record)
                        .tabItem { Label("Overview", systemImage: "info.circle") }
                        .tag(DetailTab.overview)
                    NodeDetail(node: model.selectedNode)
                        .tabItem { Label("Selection", systemImage: "doc.text.magnifyingglass") }
                        .tag(DetailTab.selection)
                    AssetsView(summary: summary)
                        .tabItem { Label("Assets", systemImage: "photo.on.rectangle") }
                        .tag(DetailTab.assets)
                    DocumentView(summary: summary)
                        .tabItem { Label("DAT / JSON", systemImage: "doc.plaintext") }
                        .tag(DetailTab.document)
                    SimilarityView()
                        .tabItem { Label("Similar", systemImage: "sparkle.magnifyingglass") }
                        .tag(DetailTab.similar)
                }
                .padding(.top, 6)
            } else {
                LibraryBrowser()
            }
        }
    }
}

struct HeaderCard: View {
    let summary: AnalysisSummary

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(summary.title ?? summary.name).font(.title2).bold()
            HStack(spacing: 12) {
                Tag(text: summary.system)
                Tag(text: "\(summary.fileCount) files")
                Tag(text: humanSize(summary.totalSize))
                if summary.fromCache { Tag(text: "cached", tint: .orange) }
            }
            Text(summary.sha256).font(.caption.monospaced()).foregroundStyle(.secondary)
                .textSelection(.enabled)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding()
    }
}

/// Formatted build metadata shown on load — the readable counterpart to the raw DAT/XML.
/// Renders only the fields present in the record (`AnalysisSummary.json`, decoded).
struct BuildOverview: View {
    let summary: AnalysisSummary
    let record: RecordDoc?

    var body: some View {
        Form {
            Section("Image") {
                let img = record?.image
                row("Name", img?.name ?? summary.name)
                row("Size", humanSize(img?.size ?? summary.totalSize))
                if let h = img?.md5 { HashRow(label: "MD5", value: h) }
                if let h = img?.sha1 { HashRow(label: "SHA-1", value: h) }
                HashRow(label: "SHA-256", value: img?.sha256 ?? summary.sha256)
            }

            if let info = record?.info {
                Section("Disc") {
                    row("System", info.system ?? summary.system)
                    row("System ID", info.systemIdentifier)
                    row("Disc type", info.discType)
                }
                if let h = info.header, !h.isEmpty {
                    Section("Header") {
                        row("Title", h.title)
                        row("Product №", h.productNumber)
                        row("Version", h.productVersion)
                        row("Release date", prettyDate(h.releaseDate))
                        row("Maker", h.makerId)
                        row("Device", h.deviceInfo)
                        row("Regions", h.regions)
                    }
                }
                if let s = info.sfo, !s.isEmpty {
                    Section("SFO") {
                        row("Title", s.title)
                        row("Disc ID", s.discId)
                        row("Disc version", s.discVersion)
                        row("Category", s.category)
                        row("Parental level", s.parentalLevel)
                        row("System version", s.systemVersion)
                    }
                }
                if let v = info.volume, !v.isEmpty {
                    Section("Volume") {
                        row("Identifier", v.identifier)
                        row("Set identifier", v.setIdentifier)
                        row("Created", prettyDate(v.creationDate))
                        row("Modified", prettyDate(v.modificationDate))
                        row("Expires", prettyDate(v.expirationDate))
                        row("Effective", prettyDate(v.effectiveDate))
                    }
                }
                if let e = info.exe {
                    Section("Boot executable") {
                        row("Filename", e.filename)
                        row("Date", prettyDate(e.date))
                        row("Signing", e.signingType)
                        if let n = e.numSymbols { row("Symbols", "\(n)") }
                    }
                }
                if let a = info.altExe {
                    Section("Alternate executable") {
                        row("Filename", a.filename)
                        row("Date", prettyDate(a.date))
                        if let h = a.md5 { HashRow(label: "Decrypted MD5", value: h) }
                    }
                }
            }

            if let c = record?.composites, hasContent(c) {
                Section("Content") {
                    if let h = c.contentHash { HashRow(label: "Content hash", value: h) }
                    if let h = c.filteredContentHash { HashRow(label: "Filtered hash", value: h) }
                    if let h = c.hashExe { HashRow(label: "Boot exe hash", value: h) }
                    if let m = c.mostRecentFile?.path { row("Most recent file", m) }
                    if let n = c.incompleteFiles, n > 0 { row("Incomplete files", "\(n)") }
                }
            }

            if let s = record?.structural {
                Section("Structure") {
                    row("Files", "\(s.fileCount ?? summary.fileCount)")
                    row("Total size", humanSize(s.totalSize ?? summary.totalSize))
                }
            }
        }
        .formStyle(.grouped)
    }

    @ViewBuilder
    private func row(_ label: String, _ value: String?) -> some View {
        if let value, !value.isEmpty {
            LabeledContent(label) {
                Text(value).textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .trailing)
            }
        }
    }

    private func hasContent(_ c: RecordDoc.Composites) -> Bool {
        c.contentHash != nil || c.filteredContentHash != nil || c.hashExe != nil
            || c.mostRecentFile?.path != nil || (c.incompleteFiles ?? 0) > 0
    }
}

struct NodeDetail: View {
    let node: DiscNode?

    var body: some View {
        if let node {
            let f = node.node
            Form {
                LabeledContent("Name", value: f.name)
                LabeledContent("Type", value: f.isDir ? "Directory" : "File")
                if !f.isDir { LabeledContent("Size", value: humanSize(f.size)) }
                if let d = f.date { LabeledContent("Date", value: d) }
                if f.unreadable { LabeledContent("Status", value: "Unreadable (bad dump)") }
                if let h = f.md5 { HashRow(label: "MD5", value: h) }
                if let h = f.sha1 { HashRow(label: "SHA-1", value: h) }
                if let h = f.sha256 { HashRow(label: "SHA-256", value: h) }
            }
            .formStyle(.grouped)
        } else {
            ContentUnavailableViewCompat(
                title: "No selection",
                systemImage: "sidebar.left",
                message: "Pick a file in the sidebar to see its hashes and metadata."
            )
        }
    }
}

struct DocumentView: View {
    let summary: AnalysisSummary
    @EnvironmentObject var model: AppModel

    var body: some View {
        VStack(spacing: 0) {
            Picker("Format", selection: $model.docMode) {
                ForEach(DocMode.allCases) { Text($0.rawValue).tag($0) }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .padding(8)
            ScrollView([.vertical, .horizontal]) {
                Text(model.docMode == .xml ? summary.xml : summary.json)
                    .font(.system(.body, design: .monospaced))
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(8)
            }
        }
    }
}

// MARK: - Assets (browser-viewable files extracted from the build)

/// Display order for asset kinds — mirrors the web build pages.
private let assetKindOrder = ["image", "audio", "video", "source", "text"]

private func assetKindIcon(_ kind: String) -> String {
    switch kind {
    case "image": return "photo"
    case "audio": return "music.note"
    case "video": return "film"
    case "source": return "chevron.left.forwardslash.chevron.right"
    default: return "doc.text"
    }
}

private func assetKindTitle(_ kind: String) -> String {
    kind == "source" ? "Source code" : kind.capitalized
}

struct AssetsView: View {
    @EnvironmentObject var model: AppModel
    let summary: AnalysisSummary

    private var grouped: [(String, [AssetInfo])] {
        let assets = summary.assets ?? []
        return assetKindOrder
            .map { kind in (kind, assets.filter { $0.kind == kind }) }
            .filter { !$0.1.isEmpty }
    }

    var body: some View {
        if grouped.isEmpty {
            ContentUnavailableViewCompat(
                title: "No viewable assets",
                systemImage: "photo.on.rectangle",
                message: summary.assets == nil
                    ? "Asset extraction hasn't run for this build yet — re-analyze the image to extract viewable files."
                    : "This build carries no browser-viewable images, audio, video, source, or text."
            )
        } else {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 12) {
                    ForEach(grouped, id: \.0) { kind, assets in
                        Text("\(assetKindTitle(kind)) (\(assets.count))")
                            .font(.caption.bold()).foregroundStyle(.secondary)
                            .padding(.horizontal, 12)
                        if kind == "image" {
                            LazyVGrid(columns: [GridItem(.adaptive(minimum: 120, maximum: 180), spacing: 8)], spacing: 8) {
                                ForEach(assets, id: \.sha256) { AssetThumb(asset: $0) }
                            }
                            .padding(.horizontal, 12)
                        } else {
                            VStack(spacing: 0) {
                                ForEach(assets, id: \.sha256) { a in
                                    AssetRow(asset: a)
                                    Divider()
                                }
                            }
                        }
                    }
                }
                .padding(.vertical, 10)
            }
        }
    }
}

/// One image asset as a clickable thumbnail (decoded off the main thread).
struct AssetThumb: View {
    @EnvironmentObject var model: AppModel
    let asset: AssetInfo
    @State private var image: NSImage?

    var body: some View {
        VStack(spacing: 4) {
            Group {
                if let image {
                    Image(nsImage: image).resizable().aspectRatio(contentMode: .fit)
                } else {
                    Image(systemName: asset.blobPath == nil ? "photo.badge.exclamationmark" : "photo")
                        .font(.system(size: 28)).foregroundStyle(.tertiary)
                }
            }
            .frame(maxWidth: .infinity, minHeight: 90, maxHeight: 120)
            .background(.quaternary, in: RoundedRectangle(cornerRadius: 6))
            Text((asset.path as NSString).lastPathComponent)
                .font(.caption2).lineLimit(1).truncationMode(.middle)
        }
        .contentShape(Rectangle())
        .onTapGesture { model.openAsset(asset) }
        .contextMenu { AssetMenu(asset: asset) }
        .help(asset.path)
        .task {
            guard image == nil, let blob = asset.blobPath else { return }
            // Read off the main thread (Data is Sendable; NSImage is not);
            // NSImage defers the actual decode until first draw.
            let data = await Task.detached(priority: .utility) {
                try? Data(contentsOf: URL(fileURLWithPath: blob))
            }.value
            if let data { image = NSImage(data: data) }
        }
    }
}

/// One audio/video/text asset as a clickable list row.
struct AssetRow: View {
    @EnvironmentObject var model: AppModel
    let asset: AssetInfo

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: assetKindIcon(asset.kind)).foregroundStyle(.secondary)
                .frame(width: 18)
            VStack(alignment: .leading, spacing: 1) {
                Text((asset.path as NSString).lastPathComponent).lineLimit(1)
                Text(asset.path).font(.caption).foregroundStyle(.secondary)
                    .lineLimit(1).truncationMode(.middle)
            }
            Spacer()
            if asset.blobPath == nil { Tag(text: "not local", tint: .orange) }
            Text(humanSize(asset.size)).font(.caption).foregroundStyle(.secondary).monospacedDigit()
            Text(asset.mime).font(.caption).foregroundStyle(.tertiary)
        }
        .padding(.horizontal, 12).padding(.vertical, 5)
        .contentShape(Rectangle())
        .onTapGesture { model.openAsset(asset) }
        .contextMenu { AssetMenu(asset: asset) }
    }
}

/// Shared context-menu actions for an asset.
struct AssetMenu: View {
    @EnvironmentObject var model: AppModel
    let asset: AssetInfo

    var body: some View {
        Button(asset.kind == "text" || asset.kind == "source" ? "Preview" : "Open") { model.openAsset(asset) }
        Button("Copy SHA-256") {
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(asset.sha256, forType: .string)
        }
    }
}

/// In-app viewer for text assets (they are never handed to the shell).
struct AssetTextSheet: View {
    let preview: AssetTextPreview
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Label(preview.name, systemImage: "doc.text").font(.headline)
            ScrollView([.vertical, .horizontal]) {
                Text(preview.text.isEmpty ? "(empty file)" : preview.text)
                    .font(.system(.callout, design: .monospaced))
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(8)
            }
            .frame(minWidth: 480, minHeight: 240, maxHeight: 480)
            .background(.quaternary, in: RoundedRectangle(cornerRadius: 6))
            HStack {
                if preview.truncated {
                    Text("Preview truncated to the first 256 KB.")
                        .font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                Button("Copy") {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(preview.text, forType: .string)
                }
                Button("Close") { dismiss() }
                    .keyboardShortcut(.defaultAction)
            }
        }
        .padding(16)
        .frame(width: 640)
    }
}

// MARK: - Similarity

struct SimilarityView: View {
    @EnvironmentObject var model: AppModel

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Button { model.findSimilar() } label: { Label("Find Similar", systemImage: "sparkle.magnifyingglass") }
                    .disabled(model.isQuerying)
                Button { model.showingSubmitSheet = true } label: { Label("Submit…", systemImage: "square.and.arrow.up") }
                    .disabled(model.isQuerying)
                if model.isQuerying { ProgressView().controlSize(.small) }
                Spacer()
            }
            .padding(8)
            Divider()

            if let sim = model.similarity, !sim.isEmpty {
                List {
                    ForEach(sim.sections, id: \.0) { title, neighbors in
                        Section(title) {
                            ForEach(neighbors) { NeighborRow(neighbor: $0) }
                        }
                    }
                }
            } else {
                ContentUnavailableViewCompat(
                    title: "Similar builds",
                    systemImage: "sparkle.magnifyingglass",
                    message: model.serviceMessage
                        ?? "Query the web service for builds that share content, files, chunks, audio, executables, or descriptions."
                )
            }
        }
    }
}

struct NeighborRow: View {
    @EnvironmentObject var model: AppModel
    let neighbor: SimilarNeighbor
    var body: some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text(neighbor.name ?? neighbor.sha256).lineLimit(1)
                Text(neighbor.sha256).font(.caption.monospaced()).foregroundStyle(.secondary)
                    .lineLimit(1).truncationMode(.middle)
            }
            Spacer()
            if let system = neighbor.system { Tag(text: system) }
            if let score = neighbor.scoreText {
                Text(score).font(.caption.monospaced().bold()).foregroundStyle(.tint)
            }
        }
        .padding(.vertical, 2)
        .contentShape(Rectangle())
        .onTapGesture { model.openInWeb(sha256: neighbor.sha256) }
        .contextMenu {
            Button("Open in Web") { model.openInWeb(sha256: neighbor.sha256) }
            Button("Copy SHA-256") {
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(neighbor.sha256, forType: .string)
            }
        }
        .help("Open \(neighbor.sha256) in the web library")
    }
}

struct SubmitSheet: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @State private var nickname = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Submit build").font(.headline)
            Text("Adds this build to the moderation queue. A nickname is attached for attribution.")
                .font(.callout).foregroundStyle(.secondary)
            TextField("Nickname", text: $nickname)
                .textFieldStyle(.roundedBorder)
                .onSubmit(send)
            HStack {
                Spacer()
                Button("Cancel") { dismiss() }
                Button("Submit") { send() }
                    .keyboardShortcut(.defaultAction)
                    .disabled(nickname.trimmingCharacters(in: .whitespaces).isEmpty)
            }
        }
        .padding(20)
        .frame(width: 380)
    }

    private func send() {
        model.submit(nickname: nickname)
        dismiss()
    }
}

// MARK: - Status bar (progress)

struct StatusBar: View {
    @EnvironmentObject var model: AppModel

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if !model.counters.isEmpty {
                ForEach(model.counters) { c in
                    if let frac = c.fraction {
                        ProgressView(value: frac) { Text(c.label).font(.caption) }
                    } else {
                        ProgressView { Text(c.label).font(.caption) }
                    }
                }
            }
            HStack {
                if model.isWorking || model.isQuerying { ProgressView().controlSize(.small) }
                Text(model.status).font(.callout).foregroundStyle(.secondary)
                Spacer()
                if let msg = model.serviceMessage {
                    Text(msg).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                }
                if let err = model.errorMessage {
                    Text(err).font(.caption).foregroundStyle(.red).lineLimit(1)
                }
                Text("library: \(model.libraryCount)").font(.caption).foregroundStyle(.tertiary)
            }
        }
        .padding(8)
        .background(.bar)
    }
}

// MARK: - Small reusable bits

struct Tag: View {
    let text: String
    var tint: Color = .accentColor
    var body: some View {
        Text(text)
            .font(.caption).bold()
            .padding(.horizontal, 8).padding(.vertical, 3)
            .background(tint.opacity(0.15), in: Capsule())
            .foregroundStyle(tint)
    }
}

struct HashRow: View {
    let label: String
    let value: String
    var body: some View {
        LabeledContent(label) {
            Text(value).font(.caption.monospaced()).textSelection(.enabled)
                .lineLimit(1).truncationMode(.middle)
        }
    }
}

/// `ContentUnavailableView` shim (the system view is macOS 14+; keep our floor at 13).
struct ContentUnavailableViewCompat: View {
    let title: String
    let systemImage: String
    let message: String
    var body: some View {
        VStack(spacing: 10) {
            Image(systemName: systemImage).font(.system(size: 42)).foregroundStyle(.tertiary)
            Text(title).font(.headline)
            Text(message).font(.callout).foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding()
    }
}
