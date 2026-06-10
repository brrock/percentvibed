const std = @import("std");

const Agent = enum { pi, codex, claude, cursor_cli, droid, generic };

const ScanArgs = struct {
    repo: []const u8,
    since: []const u8,
    since_ns: i96,
    json: bool,
};

pub fn main(init: std.process.Init) !void {
    const allocator = init.arena.allocator();
    const args = try parseArgs(allocator, init.minimal.args);

    var sessions: std.ArrayList([]const u8) = .empty;
    try scanConfiguredDirectories(allocator, init.io, init.environ_map, args.repo, args.since_ns, &sessions);

    var output: std.ArrayList(u8) = .empty;
    try output.appendSlice(allocator, "{\"version\":1,\"sessions\":[");
    for (sessions.items, 0..) |session, index| {
        if (index > 0) try output.appendSlice(allocator, ",");
        try output.appendSlice(allocator, session);
    }
    try output.appendSlice(allocator, "]}\n");

    var stdout_buffer: [4096]u8 = undefined;
    var stdout = std.Io.File.stdout().writerStreaming(init.io, &stdout_buffer);
    try stdout.interface.writeAll(output.items);
    try stdout.interface.flush();
}

fn parseArgs(allocator: std.mem.Allocator, process_args: std.process.Args) !ScanArgs {
    var iterator = try std.process.Args.Iterator.initAllocator(process_args, allocator);
    defer iterator.deinit();

    _ = iterator.next();

    var repo: ?[]const u8 = null;
    var since: ?[]const u8 = null;
    var json = false;

    while (iterator.next()) |arg| {
        if (std.mem.eql(u8, arg, "--repo")) {
            repo = iterator.next();
        } else if (std.mem.eql(u8, arg, "--since")) {
            since = iterator.next();
        } else if (std.mem.eql(u8, arg, "--json")) {
            json = true;
        }
    }

    if (repo == null or since == null or !json) {
        std.debug.print("usage: percentvibed-scan --repo <repo-root> --since <iso-date> --json\n", .{});
        std.process.exit(2);
    }

    return .{
        .repo = repo.?,
        .since = since.?,
        .since_ns = parseIsoTimestampNs(since.?) catch 0,
        .json = json,
    };
}

fn parseIsoTimestampNs(value: []const u8) !i96 {
    if (value.len < 19) return error.InvalidTimestamp;

    const year = try std.fmt.parseInt(i64, value[0..4], 10);
    const month = try std.fmt.parseInt(i64, value[5..7], 10);
    const day = try std.fmt.parseInt(i64, value[8..10], 10);
    const hour = try std.fmt.parseInt(i64, value[11..13], 10);
    const minute = try std.fmt.parseInt(i64, value[14..16], 10);
    const second = try std.fmt.parseInt(i64, value[17..19], 10);

    const days = daysFromCivil(year, month, day);
    const seconds = (((days * 24) + hour) * 60 + minute) * 60 + second;
    return @as(i96, @intCast(seconds)) * 1_000_000_000;
}

fn daysFromCivil(year_value: i64, month_value: i64, day: i64) i64 {
    var year = year_value;
    const month = month_value;

    if (month <= 2) year -= 1;

    const era = @divFloor(year, 400);
    const yoe = year - era * 400;
    const month_adjusted = if (month > 2) month - 3 else month + 9;
    const doy = @divFloor(153 * month_adjusted + 2, 5) + day - 1;
    const doe = yoe * 365 + @divFloor(yoe, 4) - @divFloor(yoe, 100) + doy;

    return era * 146097 + doe - 719468;
}

fn scanConfiguredDirectories(
    allocator: std.mem.Allocator,
    io: std.Io,
    environ: *std.process.Environ.Map,
    repo: []const u8,
    since_ns: i96,
    sessions: *std.ArrayList([]const u8),
) !void {
    if (environ.get("PERCENTVIBED_SCAN_DIRS")) |value| {
        var iterator = std.mem.splitScalar(u8, value, ':');
        while (iterator.next()) |directory| {
            try scanDirectory(allocator, io, directory, repo, since_ns, .generic, sessions);
        }
        return;
    }

    const home = environ.get("HOME") orelse return;
    const targets = [_]struct { suffix: []const u8, agent: Agent }{
        .{ .suffix = "/.pi/agent/sessions", .agent = .pi },
        .{ .suffix = "/.codex/sessions", .agent = .codex },
        .{ .suffix = "/.claude/projects", .agent = .claude },
        .{ .suffix = "/.cursor/chats", .agent = .cursor_cli },
        .{ .suffix = "/.cursor/projects", .agent = .cursor_cli },
        .{ .suffix = "/.factory", .agent = .droid },
    };

    for (targets) |target| {
        const path = try std.mem.concat(allocator, u8, &.{ home, target.suffix });
        try scanDirectory(allocator, io, path, repo, since_ns, target.agent, sessions);
    }
}

fn scanDirectory(
    allocator: std.mem.Allocator,
    io: std.Io,
    directory: []const u8,
    repo: []const u8,
    since_ns: i96,
    agent: Agent,
    sessions: *std.ArrayList([]const u8),
) !void {
    var dir = std.Io.Dir.openDirAbsolute(io, directory, .{ .iterate = true }) catch return;
    defer dir.close(io);

    var walker = try dir.walk(allocator);
    defer walker.deinit();

    var inspected: usize = 0;
    while (try walker.next(io)) |entry| {
        if (inspected > 200) break;
        if (entry.kind != .file) continue;
        if (std.mem.endsWith(u8, entry.basename, "-wal") or std.mem.endsWith(u8, entry.basename, "-shm")) continue;

        inspected += 1;
        const full_path = try std.fs.path.join(allocator, &.{ directory, entry.path });
        if (try scanFile(allocator, io, full_path, repo, since_ns, agent)) |session| {
            try sessions.append(allocator, session);
        }
    }
}

fn scanFile(
    allocator: std.mem.Allocator,
    io: std.Io,
    path: []const u8,
    repo: []const u8,
    since_ns: i96,
    agent: Agent,
) !?[]const u8 {
    const file = std.Io.Dir.openFileAbsolute(io, path, .{}) catch return null;
    defer file.close(io);

    const stat = try file.stat(io);
    if (stat.mtime.nanoseconds < since_ns) return null;
    if (stat.size == 0 or stat.size > 2_000_000) return null;

    const bytes = try allocator.alloc(u8, @intCast(stat.size));
    const bytes_read = try file.readPositionalAll(io, bytes, 0);
    const content = bytes[0..bytes_read];
    if (looksBinary(content)) return null;

    var files = std.StringHashMap(void).init(allocator);
    try extractRepoFiles(allocator, content, repo, &files);
    try extractJsonPathFields(allocator, content, &files);

    if (files.count() == 0) return null;

    const has_edit_evidence = hasEditEvidence(content, agent);
    const hash = try sha256Hex(allocator, path);
    var out: std.ArrayList(u8) = .empty;
    try out.appendSlice(
        allocator,
        try std.fmt.allocPrint(
            allocator,
            "{{\"source\":\"{s}\",\"pathHash\":\"sha256:{s}\",\"filesMentioned\":[",
            .{ agentName(agent), hash },
        ),
    );

    var iterator = files.keyIterator();
    var index: usize = 0;
    while (iterator.next()) |file_name| {
        if (index > 0) try out.appendSlice(allocator, ",");
        try out.appendSlice(
            allocator,
            try std.fmt.allocPrint(allocator, "\"{s}\"", .{file_name.*}),
        );
        index += 1;
    }

    try out.appendSlice(allocator, "],\"commandsSeen\":[],\"editEvents\":[");

    if (has_edit_evidence) {
        var event_iterator = files.keyIterator();
        var event_index: usize = 0;
        while (event_iterator.next()) |file_name| {
            if (event_index > 0) try out.appendSlice(allocator, ",");
            const line_stats = patchStatsForFile(content, file_name.*);
            try appendEditEvent(allocator, &out, agent, file_name.*, hash, line_stats.added, line_stats.deleted);
            event_index += 1;
        }
    }

    try out.appendSlice(
        allocator,
        try std.fmt.allocPrint(
            allocator,
            "],\"confidence\":{d:.2}}}",
            .{if (has_edit_evidence) confidenceForEdit(agent) else confidenceFor(agent)},
        ),
    );

    return try out.toOwnedSlice(allocator);
}

fn extractRepoFiles(
    allocator: std.mem.Allocator,
    bytes: []const u8,
    repo: []const u8,
    files: *std.StringHashMap(void),
) !void {
    var index: usize = 0;
    while (std.mem.indexOfPos(u8, bytes, index, repo)) |match| {
        var end = match;
        while (end < bytes.len and !isPathTerminator(bytes[end])) : (end += 1) {}
        if (end > match + repo.len + 1) {
            const relative = bytes[match + repo.len + 1 .. end];
            if (isSafeRelativePath(relative)) try files.put(try allocator.dupe(u8, relative), {});
        }
        index = end;
    }
}

fn extractJsonPathFields(
    allocator: std.mem.Allocator,
    bytes: []const u8,
    files: *std.StringHashMap(void),
) !void {
    const keys = [_][]const u8{
        "\"path\"",
        "\"file\"",
        "\"file_path\"",
        "\"filePath\"",
        "\"filename\"",
        "\"target\"",
    };

    for (keys) |key| {
        var index: usize = 0;
        while (std.mem.indexOfPos(u8, bytes, index, key)) |match| {
            if (extractJsonStringValue(bytes, match + key.len)) |value| {
                if (isSafeRelativePath(value)) {
                    try files.put(try allocator.dupe(u8, value), {});
                }
                index = @min(bytes.len, match + key.len + value.len + 4);
            } else {
                index = match + key.len;
            }
        }
    }
}

fn extractJsonStringValue(bytes: []const u8, start: usize) ?[]const u8 {
    var index = start;
    while (index < bytes.len and (bytes[index] == ' ' or bytes[index] == '\t' or bytes[index] == ':')) {
        index += 1;
    }

    if (index >= bytes.len or bytes[index] != '"') return null;
    index += 1;

    const value_start = index;
    while (index < bytes.len and bytes[index] != '"') {
        if (bytes[index] == '\\') return null;
        index += 1;
    }

    if (index >= bytes.len) return null;
    return bytes[value_start..index];
}

const LineStats = struct {
    added: usize,
    deleted: usize,
};

fn patchStatsForFile(bytes: []const u8, file_name: []const u8) LineStats {
    const escaped_stats = escapedPatchStatsForFile(bytes, file_name);
    if (escaped_stats.added > 0 or escaped_stats.deleted > 0) return escaped_stats;

    var stats = LineStats{ .added = 0, .deleted = 0 };
    var in_file = false;
    var saw_patch_header = false;

    var iterator = std.mem.splitScalar(u8, bytes, '\n');
    while (iterator.next()) |line| {
        if (std.mem.startsWith(u8, line, "+++ ")) {
            in_file = std.mem.endsWith(u8, line, file_name);
            saw_patch_header = in_file;
            continue;
        }

        if (std.mem.startsWith(u8, line, "--- ")) continue;
        if (std.mem.startsWith(u8, line, "@@")) continue;

        if (in_file and std.mem.startsWith(u8, line, "+") and !std.mem.startsWith(u8, line, "+++")) {
            stats.added += 1;
        }

        if (in_file and std.mem.startsWith(u8, line, "-") and !std.mem.startsWith(u8, line, "---")) {
            stats.deleted += 1;
        }
    }

    if (saw_patch_header) return stats;

    return editBlockStats(bytes);
}

fn escapedPatchStatsForFile(bytes: []const u8, file_name: []const u8) LineStats {
    var stats = LineStats{ .added = 0, .deleted = 0 };
    const patch_key = "\"patch\"";
    const patch_start = std.mem.indexOf(u8, bytes, patch_key) orelse return stats;
    const patch_bytes = bytes[patch_start..];

    const plus_header = std.fmt.allocPrint(std.heap.page_allocator, "+++ {s}", .{file_name}) catch return stats;
    defer std.heap.page_allocator.free(plus_header);

    const file_start = std.mem.indexOf(u8, patch_bytes, plus_header) orelse return stats;
    var index = file_start;

    while (std.mem.indexOfPos(u8, patch_bytes, index, "\\n")) |match| {
        const next = match + 2;
        if (next >= patch_bytes.len) break;

        if (patch_bytes[next] == '"') break;
        if (patch_bytes[next] == '+' and !std.mem.startsWith(u8, patch_bytes[next..], "+++")) stats.added += 1;
        if (patch_bytes[next] == '-' and !std.mem.startsWith(u8, patch_bytes[next..], "---")) stats.deleted += 1;

        index = next;
    }

    return stats;
}

fn editBlockStats(bytes: []const u8) LineStats {
    const old_lines = countEscapedNewlinesAfterKey(bytes, "\"oldText\"") +
        countEscapedNewlinesAfterKey(bytes, "\"old_string\"") +
        countEscapedNewlinesAfterKey(bytes, "\"oldString\"");
    const new_lines = countEscapedNewlinesAfterKey(bytes, "\"newText\"") +
        countEscapedNewlinesAfterKey(bytes, "\"new_string\"") +
        countEscapedNewlinesAfterKey(bytes, "\"newString\"");

    if (new_lines > old_lines) return .{ .added = new_lines - old_lines, .deleted = 0 };
    if (old_lines > new_lines) return .{ .added = 0, .deleted = old_lines - new_lines };
    return .{ .added = 0, .deleted = 0 };
}

fn countEscapedNewlinesAfterKey(bytes: []const u8, key: []const u8) usize {
    if (std.mem.indexOf(u8, bytes, key)) |start| {
        if (extractJsonStringValue(bytes, start + key.len)) |value| {
            var count: usize = 1;
            var index: usize = 0;
            while (std.mem.indexOfPos(u8, value, index, "\\n")) |match| {
                count += 1;
                index = match + 2;
            }
            return count;
        }
    }

    return 0;
}

fn hasEditEvidence(bytes: []const u8, agent: Agent) bool {
    _ = agent;

    const needles = [_][]const u8{
        "\"name\":\"edit\"",
        "\"name\": \"edit\"",
        "\"name\":\"write\"",
        "\"name\": \"write\"",
        "\"name\":\"apply_patch\"",
        "\"name\": \"apply_patch\"",
        "\"tool_name\":\"Edit\"",
        "\"tool_name\": \"Edit\"",
        "\"tool_name\":\"Write\"",
        "\"tool_name\": \"Write\"",
        "\"name\":\"Edit\"",
        "\"name\": \"Edit\"",
        "\"name\":\"Write\"",
        "\"name\": \"Write\"",
        "apply_patch",
        "*** Begin Patch",
    };

    for (needles) |needle| {
        if (std.mem.indexOf(u8, bytes, needle) != null) return true;
    }

    return false;
}

fn appendEditEvent(
    allocator: std.mem.Allocator,
    out: *std.ArrayList(u8),
    agent: Agent,
    file_name: []const u8,
    session_hash: []const u8,
    added: usize,
    deleted: usize,
) !void {
    try out.appendSlice(
        allocator,
        try std.fmt.allocPrint(
            allocator,
            "{{\"agent\":\"{s}\",\"kind\":\"{s}\",\"file\":\"{s}\",\"confidence\":{d:.2},\"evidence\":{{\"source\":\"tool_call\",\"toolName\":\"{s}\",\"sessionFileHash\":\"sha256:{s}\"}},\"stats\":{{\"added\":{d},\"deleted\":{d}}}}}",
            .{
                agentName(agent),
                editKind(agent),
                file_name,
                confidenceForEdit(agent),
                editToolName(agent),
                session_hash,
                added,
                deleted,
            },
        ),
    );
}

fn isPathTerminator(byte: u8) bool {
    return byte == '"' or byte == '\'' or byte == '\n' or byte == '\r' or byte == '\t' or byte == ' ';
}

fn isSafeRelativePath(path: []const u8) bool {
    if (path.len == 0 or path[0] == '/' or std.mem.indexOf(u8, path, "..") != null) return false;
    if (std.mem.eql(u8, path, ".") or std.mem.eql(u8, path, "./")) return false;
    if (std.mem.startsWith(u8, path, ".percentvibed/")) return false;
    return std.mem.indexOfScalar(u8, path, '.') != null;
}

fn looksBinary(bytes: []const u8) bool {
    const limit = @min(bytes.len, 4096);
    return std.mem.indexOfScalar(u8, bytes[0..limit], 0) != null;
}

fn sha256Hex(allocator: std.mem.Allocator, bytes: []const u8) ![]const u8 {
    var digest: [32]u8 = undefined;
    std.crypto.hash.sha2.Sha256.hash(bytes, &digest, .{});
    const hex = std.fmt.bytesToHex(digest, .lower);
    return try allocator.dupe(u8, &hex);
}

fn agentName(agent: Agent) []const u8 {
    return switch (agent) {
        .pi => "pi",
        .codex => "codex",
        .claude => "claude",
        .cursor_cli => "cursor-cli",
        .droid => "droid",
        .generic => "unknown",
    };
}

fn confidenceFor(agent: Agent) f32 {
    return switch (agent) {
        .pi, .codex => 0.45,
        .claude => 0.40,
        .cursor_cli, .droid, .generic => 0.25,
    };
}

fn confidenceForEdit(agent: Agent) f32 {
    return switch (agent) {
        .pi, .codex => 0.90,
        .claude => 0.85,
        .cursor_cli => 0.55,
        .droid, .generic => 0.45,
    };
}

fn editKind(agent: Agent) []const u8 {
    return switch (agent) {
        .codex => "apply_patch",
        .pi, .claude, .cursor_cli, .droid, .generic => "edit",
    };
}

fn editToolName(agent: Agent) []const u8 {
    return switch (agent) {
        .codex => "apply_patch",
        .claude => "Edit",
        .pi, .cursor_cli, .droid, .generic => "edit",
    };
}
