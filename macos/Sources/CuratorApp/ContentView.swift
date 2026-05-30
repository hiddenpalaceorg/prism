import SwiftUI
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
        .toolbar {
            ToolbarItemGroup {
                Button { model.openDialog() } label: { Label("Open", systemImage: "folder") }
                    .disabled(model.isWorking)
                if model.isWorking {
                    Button(role: .cancel) { model.cancel() } label: { Label("Cancel", systemImage: "stop.circle") }
                }
            }
        }
        .safeAreaInset(edge: .bottom) { StatusBar() }
    }
}

// MARK: - Sidebar (file tree)

struct SidebarView: View {
    @EnvironmentObject var model: AppModel

    var body: some View {
        Group {
            if model.rootNodes.isEmpty {
                ContentUnavailableViewCompat(
                    title: "No image loaded",
                    systemImage: "opticaldisc",
                    message: "Open a disc image, container, or folder to see its contents."
                )
            } else {
                List(selection: $model.selection) {
                    ForEach(model.rootNodes) { root in
                        OutlineGroup(root, children: \.children) { node in
                            Label(node.name, systemImage: node.isDir ? "folder" : "doc")
                                .tag(node.id)
                        }
                    }
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
                TabView {
                    NodeDetail(node: model.selectedNode)
                        .tabItem { Label("Selection", systemImage: "info.circle") }
                    DocumentView(summary: summary)
                        .tabItem { Label("Document", systemImage: "doc.text") }
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
                if model.isWorking { ProgressView().controlSize(.small) }
                Text(model.status).font(.callout).foregroundStyle(.secondary)
                Spacer()
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
