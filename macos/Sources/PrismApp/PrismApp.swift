import SwiftUI

@main
struct PrismApp: App {
    @StateObject private var model = AppModel()

    var body: some Scene {
        WindowGroup("Prism") {
            ContentView()
                .environmentObject(model)
                .frame(minWidth: 900, minHeight: 560)
        }
        .commands {
            CommandGroup(replacing: .newItem) {
                Button("Open…") { model.openDialog() }
                    .keyboardShortcut("o", modifiers: .command)
                    .disabled(model.isWorking)
                Button("Open Folder as Build…") { model.openFolderAsBuildDialog() }
                    .keyboardShortcut("o", modifiers: [.command, .shift])
                Button("Re-analyze Image (fresh)…") { model.reanalyzeDialog() }
                    .keyboardShortcut("r", modifiers: [.command, .shift])
                    .disabled(model.isWorking)
                Divider()
                Button("Export Library for Upload…") { model.exportLibrary() }
                    .keyboardShortcut("e", modifiers: .command)
                    .disabled(model.isWorking)
            }
        }
    }
}
