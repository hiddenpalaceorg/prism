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
        .onAppear { model.loadRecentAtLaunch() }
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
                Task { @MainActor in model.analyze(url: url) }
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
            } else if !model.recent.isEmpty {
                RecentList()
            } else {
                ContentUnavailableViewCompat(
                    title: "No image loaded",
                    systemImage: "opticaldisc",
                    message: "Open — or drag in — a disc image, container, or folder."
                )
            }
        }
    }
}

struct RecentList: View {
    @EnvironmentObject var model: AppModel
    var body: some View {
        List {
            Section("Recent builds") {
                ForEach(model.recent, id: \.sha256) { e in
                    Button { model.openRecent(sha256: e.sha256) } label: {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(e.name).lineLimit(1)
                            Text("\(e.system) · \(e.fileCount) files · \(humanSize(e.totalSize))")
                                .font(.caption).foregroundStyle(.secondary)
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }
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
                    DocumentView(summary: summary)
                        .tabItem { Label("DAT / JSON", systemImage: "doc.plaintext") }
                        .tag(DetailTab.document)
                    SimilarityView()
                        .tabItem { Label("Similar", systemImage: "sparkle.magnifyingglass") }
                        .tag(DetailTab.similar)
                }
                .padding(.top, 6)
            } else {
                ContentUnavailableViewCompat(
                    title: "Curator",
                    systemImage: "opticaldisc",
                    message: model.errorMessage ?? "Analysis details appear here."
                )
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
                if let v = info.volume, !v.isEmpty {
                    Section("Volume") {
                        row("Identifier", v.identifier)
                        row("Set identifier", v.setIdentifier)
                        row("Created", prettyDate(v.creationDate))
                        row("Modified", prettyDate(v.modificationDate))
                    }
                }
                if let e = info.exe {
                    Section("Boot executable") {
                        row("Filename", e.filename)
                        row("Date", prettyDate(e.date))
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
                    if let d = s.maxDepth { row("Max depth", "\(d)") }
                    if let hist = s.extHistogram, !hist.isEmpty {
                        row("Top extensions", topExtensions(hist))
                    }
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
        .help("Open \(neighbor.sha256) in the web catalog")
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
                Text("catalog: \(model.catalogCount)").font(.caption).foregroundStyle(.tertiary)
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
