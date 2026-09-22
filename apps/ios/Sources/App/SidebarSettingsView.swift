import SwiftUI

struct SidebarSettingsView: View {
  @Environment(AppStore.self) private var store
  @Environment(\.dismiss) private var dismiss
  @State private var value: JSON = .null
  @State private var name = ""
  @State private var operation = FormOperation()
  @State private var initialized = false
  private var sections: [JSON] { value["sections"].array }
  var body: some View {
    NativeList {
      Section { FormStatus(operation: operation) }
      Section("Sections") {
        ForEach(sections, id: \.self) { section in
          NavigationLink {
            SidebarGroupEditor(value: $value, id: section["id"].string)
          } label: {
            Text(section["name"].string)
          }
        }.onMove { from, to in
          var items = sections
          items.move(fromOffsets: from, toOffset: to)
          value["sections"] = .array(items)
        }.onDelete { offsets in
          let removed = Set(offsets.map { sections[$0]["id"].string })
          value["sections"] = .array(sections.filter { !removed.contains($0["id"].string) })
          value["sectionByChannel"] = .object(
            value["sectionByChannel"].object.filter { !removed.contains($0.value.string) })
          value["channelOrderByGroup"] = .object(
            value["channelOrderByGroup"].object.filter { !removed.contains($0.key) })
        }
        HStack {
          TextField("New section", text: $name).accessibilityIdentifier("section-name")
          Button("Add") {
            value["sections"] = .array(
              sections + [
                .object([
                  "id": .string(UUID().uuidString),
                  "name": .string(name.trimmingCharacters(in: .whitespacesAndNewlines)),
                  "collapsed": .bool(false),
                ])
              ])
            name = ""
          }.disabled(
            name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || name.count > 120
          ).accessibilityIdentifier("section-add")
        }
      }
      Section("Conversation order") {
        NavigationLink("Pinned") { SidebarGroupEditor(value: $value, id: "pinned") }
        NavigationLink("Unassigned") { SidebarGroupEditor(value: $value, id: "unassigned") }
      }
      Section {
        Text(
          "Use Edit to reorder or remove sections. Removing a section moves its conversations to Unassigned."
        ).font(.footnote).foregroundStyle(NativePalette.muted)
      }
    }.navigationTitle("Organize conversations").navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .topBarTrailing) { EditButton() }
        ToolbarItem(placement: .confirmationAction) {
          Button("Save") {
            Task {
              if await operation.run({
                store.sidebar = try await store.request(
                  "/api/v0/settings/sidebar", method: "PATCH", body: value)
              }) {
                dismiss()
              }
            }
          }.disabled(operation.busy).accessibilityIdentifier("sidebar-save")
        }
      }.task {
        guard !initialized else { return }
        initialized = true
        value = store.sidebar
      }
  }
}

private struct SidebarGroupEditor: View {
  @Environment(AppStore.self) private var store
  @Binding var value: JSON
  let id: String
  var section: JSON { value["sections"].array.first { $0["id"].string == id } ?? .null }
  var title: String { section == .null ? id.capitalized : section["name"].string }
  var pinned: [String] { value["pinnedIds"].array.map(\.string) }
  var rows: [Channel] {
    let candidates = store.channels.filter { channel in
      if id == "pinned" { return pinned.contains(channel.id) }
      return !pinned.contains(channel.id)
        && value["sectionByChannel"][channel.id].string == (id == "unassigned" ? "" : id)
    }
    let order = id == "pinned" ? pinned : value["channelOrderByGroup"][id].array.map(\.string)
    return candidates.sorted {
      let a = order.firstIndex(of: $0.id) ?? Int.max
      let b = order.firstIndex(of: $1.id) ?? Int.max
      return a == b ? $0.updatedAt > $1.updatedAt : a < b
    }
  }
  var body: some View {
    NativeList {
      if section != .null {
        Section("Section name") {
          TextField(
            "Name",
            text: Binding(
              get: { section["name"].string },
              set: { name in
                guard
                  let index = value["sections"].array.firstIndex(where: { $0["id"].string == id }),
                  !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                else { return }
                var items = value["sections"].array
                items[index]["name"] = .string(String(name.prefix(120)))
                value["sections"] = .array(items)
              }))
        }
      }
      Section("Conversations") {
        ForEach(rows) { channel in
          HStack {
            ChannelAvatar(channel: channel, size: 32)
            Text(channel.name)
          }
        }.onMove { from, to in
          var ids = rows.map(\.id)
          ids.move(fromOffsets: from, toOffset: to)
          if id == "pinned" {
            value["pinnedIds"] = .array(ids.map(JSON.string))
          } else {
            value["channelOrderByGroup"][id] = .array(ids.map(JSON.string))
          }
        }
        if rows.isEmpty {
          Text("Move conversations here from the home screen’s conversation menu.").foregroundStyle(
            NativePalette.muted)
        }
      }
    }.navigationTitle(title).navigationBarTitleDisplayMode(.inline).toolbar { EditButton() }
  }
}
