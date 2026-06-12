const std = @import("std");

const Agent = enum { pi, codex, claude, cursor_cli, droid, generic };

const ScanArgs = struct {
    repo: []const u8,
    since: []const u8,
    since_ns: i96,
    json: bool,
};

const LineStats = struct {
    added: usize = 0,
    deleted: usize = 0,
};

const EditEvent = struct {
    agent: Agent,
    kind: []const u8,
    file: []const u8,
    confidence: f32,
    source: []const u8,
    tool_name: ?[]const u8 = null,
    session_hash: []const u8,
    timestamp: ?[]const u8 = null,
    call_id: ?[]const u8 = null,
    patch_hash: ?[]const u8 = null,
    stats: LineStats = .{},
};

const ScanResult = struct {
    files: std.StringHashMap(void),
    events: std.ArrayList(EditEvent),

    fn init(allocator: std.mem.Allocator) ScanResult {
        return .{
            .files = std.StringHashMap(void).init(allocator),
            .events = .empty,
        };
    }
};

pub fn main(init: std.process.Init) !void {
    const allocator = init.arena.allocator();
    const args = try parseArgs(allocator, init.minimal.args);

    const output = try scanToJsonSinceNs(
        allocator,
        init.io,
        args.repo,
        args.since_ns,
        init.environ_map.get("PERCENTVIBED_SCAN_DIRS"),
        init.environ_map.get("HOME"),
    );

    var stdout_buffer: [4096]u8 = undefined;
    var stdout = std.Io.File.stdout().writerStreaming(init.io, &stdout_buffer);
    stdout.interface.writeAll(output) catch return;
    stdout.interface.flush() catch return;
}

pub fn scanToJson(
    allocator: std.mem.Allocator,
    io: std.Io,
    repo: []const u8,
    since: []const u8,
    scan_dirs: ?[]const u8,
    home: ?[]const u8,
) ![]const u8 {
    return scanToJsonSinceNs(allocator, io, repo, parseIsoTimestampNs(since) catch 0, scan_dirs, home);
}

pub fn scanToJsonSinceNs(
    allocator: std.mem.Allocator,
    io: std.Io,
    repo: []const u8,
    since_ns: i96,
    scan_dirs: ?[]const u8,
    home: ?[]const u8,
) ![]const u8 {
    var sessions: std.ArrayList([]const u8) = .empty;
    try scanConfiguredDirectories(allocator, io, repo, since_ns, scan_dirs, home, &sessions);

    var output: std.ArrayList(u8) = .empty;
    try output.appendSlice(allocator, "{\"version\":1,\"sessions\":[");
    for (sessions.items, 0..) |session, index| {
        if (index > 0) try output.appendSlice(allocator, ",");
        try output.appendSlice(allocator, session);
    }
    try output.appendSlice(allocator, "]}\n");

    return try output.toOwnedSlice(allocator);
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
    repo: []const u8,
    since_ns: i96,
    scan_dirs: ?[]const u8,
    home: ?[]const u8,
    sessions: *std.ArrayList([]const u8),
) !void {
    if (scan_dirs) |value| {
        if (value.len > 0) {
            var iterator = std.mem.splitScalar(u8, value, ':');
            while (iterator.next()) |directory| {
                if (directory.len == 0) continue;
                try scanDirectory(allocator, io, directory, repo, since_ns, .generic, sessions);
            }
            return;
        }
    }

    const home_dir = home orelse return;
    if (home_dir.len == 0) return;

    const targets = [_]struct { suffix: []const u8, agent: Agent }{
        .{ .suffix = "/.pi/agent/sessions", .agent = .pi },
        .{ .suffix = "/.codex/sessions", .agent = .codex },
        .{ .suffix = "/.claude/projects", .agent = .claude },
        .{ .suffix = "/.cursor/chats", .agent = .cursor_cli },
        .{ .suffix = "/.cursor/projects", .agent = .cursor_cli },
        .{ .suffix = "/.factory", .agent = .droid },
    };

    for (targets) |target| {
        const path = try std.mem.concat(allocator, u8, &.{ home_dir, target.suffix });
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
        if (inspected > 10_000) break;
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
    if (stat.size == 0 or stat.size > 5_000_000) return null;

    const bytes = try allocator.alloc(u8, @intCast(stat.size));
    const bytes_read = try file.readPositionalAll(io, bytes, 0);
    const content = bytes[0..bytes_read];
    if (looksBinary(content)) return null;

    const session_hash = try sha256Hex(allocator, path);
    var result = ScanResult.init(allocator);

    switch (agent) {
        .pi => try scanPi(allocator, content, repo, since_ns, session_hash, &result),
        .codex => try scanCodex(allocator, content, repo, since_ns, session_hash, &result),
        .claude => try scanClaude(allocator, content, repo, since_ns, session_hash, &result),
        .cursor_cli, .droid, .generic => try scanGeneric(allocator, content, repo, since_ns, session_hash, agent, &result),
    }

    if (result.files.count() == 0 and result.events.items.len == 0) return null;

    for (result.events.items) |event| {
        try addFile(allocator, &result, event.file);
    }

    return try renderSession(allocator, agent, session_hash, &result);
}

fn scanPi(
    allocator: std.mem.Allocator,
    content: []const u8,
    repo: []const u8,
    since_ns: i96,
    session_hash: []const u8,
    result: *ScanResult,
) !void {
    var pending = std.StringHashMap(usize).init(allocator);
    var lines = std.mem.splitScalar(u8, content, '\n');

    while (lines.next()) |line| {
        if (!lineIsAfterSince(allocator, line, since_ns)) continue;

        if (lineHasJsonString(line, "type", "toolCall")) {
            const tool_name = findJsonStringValueAlloc(allocator, line, "name") orelse continue;
            if (!isEditTool(tool_name)) continue;

            const timestamp = findJsonStringValueAlloc(allocator, line, "timestamp");
            const call_id = findJsonStringValueAlloc(allocator, line, "id");

            if (std.mem.indexOf(u8, line, "apply_patch") != null) {
                if (extractPatchPayload(allocator, line)) |patch_text| {
                    try appendPatchEvents(allocator, patch_text, repo, .pi, session_hash, "apply_patch", "apply_patch", "patch", timestamp, call_id, 0.9, result);
                    continue;
                }
            }

            const file = findPathValue(allocator, line, repo) orelse continue;
            const stats = editTextStats(allocator, line);
            const event_index = try appendEvent(allocator, result, .{
                .agent = .pi,
                .kind = kindForTool(tool_name),
                .file = file,
                .confidence = 0.9,
                .source = "tool_call",
                .tool_name = tool_name,
                .session_hash = session_hash,
                .timestamp = timestamp,
                .call_id = call_id,
                .stats = stats,
            });

            if (call_id) |id| try pending.put(id, event_index);
            continue;
        }

        const tool_result_name = findJsonStringValueAlloc(allocator, line, "toolName");
        if (tool_result_name) |tool_name| {
            if (!isEditTool(tool_name)) continue;

            const timestamp = findJsonStringValueAlloc(allocator, line, "timestamp");
            const call_id = findJsonStringValueAlloc(allocator, line, "toolCallId");
            if (extractPatchPayload(allocator, line)) |patch_text| {
                var stats_map = try patchStatsMap(allocator, patch_text, repo);
                if (call_id) |id| {
                    if (pending.get(id)) |event_index| {
                        try updatePendingEventFromPatch(allocator, result, event_index, &stats_map);
                    } else {
                        try appendEventsFromStatsMap(allocator, &stats_map, .pi, session_hash, "edit", "edit", "tool_result", timestamp, call_id, 0.85, result);
                    }
                } else {
                    try appendEventsFromStatsMap(allocator, &stats_map, .pi, session_hash, "edit", "edit", "tool_result", timestamp, call_id, 0.85, result);
                }
            }
        }
    }
}

fn scanCodex(
    allocator: std.mem.Allocator,
    content: []const u8,
    repo: []const u8,
    since_ns: i96,
    session_hash: []const u8,
    result: *ScanResult,
) !void {
    var lines = std.mem.splitScalar(u8, content, '\n');

    while (lines.next()) |line| {
        if (!lineIsAfterSince(allocator, line, since_ns)) continue;
        if (!lineHasJsonString(line, "type", "function_call") and std.mem.indexOf(u8, line, "function_call") == null) continue;

        const raw_name = findJsonStringValueAlloc(allocator, line, "name") orelse continue;
        const tool_name = stripFunctionsPrefix(raw_name);
        if (!std.mem.eql(u8, tool_name, "apply_patch") and !std.mem.eql(u8, tool_name, "exec_command") and !std.mem.eql(u8, tool_name, "write_stdin")) continue;

        const timestamp = findJsonStringValueAlloc(allocator, line, "timestamp");
        const call_id = findJsonStringValueAlloc(allocator, line, "call_id");

        if (extractPatchPayload(allocator, line)) |patch_text| {
            try appendPatchEvents(allocator, patch_text, repo, .codex, session_hash, "apply_patch", "apply_patch", "patch", timestamp, call_id, 0.9, result);
        }
    }
}

fn scanClaude(
    allocator: std.mem.Allocator,
    content: []const u8,
    repo: []const u8,
    since_ns: i96,
    session_hash: []const u8,
    result: *ScanResult,
) !void {
    var lines = std.mem.splitScalar(u8, content, '\n');

    while (lines.next()) |line| {
        if (!lineIsAfterSince(allocator, line, since_ns)) continue;

        const maybe_name = findFirstJsonStringValue(allocator, line, &.{ "tool_name", "toolName", "name" });
        const tool_name = maybe_name orelse continue;
        if (!isEditTool(tool_name)) continue;

        const timestamp = findJsonStringValueAlloc(allocator, line, "timestamp");
        const call_id = findFirstJsonStringValue(allocator, line, &.{ "id", "toolUseID", "tool_use_id" });

        if (extractPatchPayload(allocator, line)) |patch_text| {
            try appendPatchEvents(allocator, patch_text, repo, .claude, session_hash, kindForTool(tool_name), tool_name, "patch", timestamp, call_id, 0.85, result);
            continue;
        }

        const file = findPathValue(allocator, line, repo) orelse continue;
        _ = try appendEvent(allocator, result, .{
            .agent = .claude,
            .kind = kindForTool(tool_name),
            .file = file,
            .confidence = 0.85,
            .source = "tool_call",
            .tool_name = tool_name,
            .session_hash = session_hash,
            .timestamp = timestamp,
            .call_id = call_id,
            .stats = editTextStats(allocator, line),
        });
    }
}

fn scanGeneric(
    allocator: std.mem.Allocator,
    content: []const u8,
    repo: []const u8,
    since_ns: i96,
    session_hash: []const u8,
    agent: Agent,
    result: *ScanResult,
) !void {
    var lines = std.mem.splitScalar(u8, content, '\n');

    while (lines.next()) |line| {
        if (!lineIsAfterSince(allocator, line, since_ns)) continue;

        if (extractPatchPayload(allocator, line)) |patch_text| {
            try appendPatchEvents(allocator, patch_text, repo, agent, session_hash, "apply_patch", "apply_patch", "patch", null, null, confidenceForAgent(agent, true), result);
            continue;
        }

        if (!hasEditEvidence(line)) {
            if (findPathValue(allocator, line, repo)) |file| try addFile(allocator, result, file);
            continue;
        }

        const file = findPathValue(allocator, line, repo) orelse continue;
        _ = try appendEvent(allocator, result, .{
            .agent = agent,
            .kind = "unknown_edit",
            .file = file,
            .confidence = confidenceForAgent(agent, true),
            .source = "generic_scan",
            .tool_name = findFirstJsonStringValue(allocator, line, &.{ "name", "toolName", "tool_name" }),
            .session_hash = session_hash,
            .stats = editTextStats(allocator, line),
        });
    }

    try extractRepoFiles(allocator, content, repo, result);
}

fn appendPatchEvents(
    allocator: std.mem.Allocator,
    patch_text: []const u8,
    repo: []const u8,
    agent: Agent,
    session_hash: []const u8,
    kind: []const u8,
    tool_name: []const u8,
    source: []const u8,
    timestamp: ?[]const u8,
    call_id: ?[]const u8,
    confidence: f32,
    result: *ScanResult,
) !void {
    var stats_map = try patchStatsMap(allocator, patch_text, repo);
    try appendEventsFromStatsMap(allocator, &stats_map, agent, session_hash, kind, tool_name, source, timestamp, call_id, confidence, result);
}

fn appendEventsFromStatsMap(
    allocator: std.mem.Allocator,
    stats_map: *std.StringHashMap(LineStats),
    agent: Agent,
    session_hash: []const u8,
    kind: []const u8,
    tool_name: []const u8,
    source: []const u8,
    timestamp: ?[]const u8,
    call_id: ?[]const u8,
    confidence: f32,
    result: *ScanResult,
) !void {
    var iterator = stats_map.iterator();
    while (iterator.next()) |entry| {
        const file = try allocator.dupe(u8, entry.key_ptr.*);
        _ = try appendEvent(allocator, result, .{
            .agent = agent,
            .kind = kind,
            .file = file,
            .confidence = confidence,
            .source = source,
            .tool_name = tool_name,
            .session_hash = session_hash,
            .timestamp = timestamp,
            .call_id = call_id,
            .stats = entry.value_ptr.*,
        });
    }
}

fn updatePendingEventFromPatch(
    allocator: std.mem.Allocator,
    result: *ScanResult,
    event_index: usize,
    stats_map: *std.StringHashMap(LineStats),
) !void {
    if (event_index >= result.events.items.len) return;

    const file = result.events.items[event_index].file;
    if (stats_map.get(file)) |stats| {
        result.events.items[event_index].stats = stats;
        return;
    }

    var iterator = stats_map.iterator();
    if (iterator.next()) |entry| {
        result.events.items[event_index].file = try allocator.dupe(u8, entry.key_ptr.*);
        result.events.items[event_index].stats = entry.value_ptr.*;
    }
}

fn appendEvent(allocator: std.mem.Allocator, result: *ScanResult, event: EditEvent) !usize {
    try addFile(allocator, result, event.file);
    try result.events.append(allocator, event);
    return result.events.items.len - 1;
}

fn addFile(allocator: std.mem.Allocator, result: *ScanResult, file: []const u8) !void {
    if (!isSafeRelativePath(file)) return;
    try result.files.put(try allocator.dupe(u8, file), {});
}

fn extractRepoFiles(
    allocator: std.mem.Allocator,
    bytes: []const u8,
    repo: []const u8,
    result: *ScanResult,
) !void {
    var index: usize = 0;
    while (std.mem.indexOfPos(u8, bytes, index, repo)) |match| {
        var end = match;
        while (end < bytes.len and !isPathTerminator(bytes[end])) : (end += 1) {}
        if (end > match + repo.len + 1) {
            const relative = bytes[match + repo.len + 1 .. end];
            if (isSafeRelativePath(relative)) try addFile(allocator, result, relative);
        }
        index = end;
    }
}

fn findPathValue(allocator: std.mem.Allocator, bytes: []const u8, repo: []const u8) ?[]const u8 {
    const keys = [_][]const u8{ "file_path", "filePath", "path", "filename", "file", "target" };
    for (keys) |key| {
        if (findJsonStringValueAlloc(allocator, bytes, key)) |value| {
            if (normalizePath(allocator, value, repo)) |file| return file;
        }
    }
    return null;
}

fn normalizePath(allocator: std.mem.Allocator, value: []const u8, repo: []const u8) ?[]const u8 {
    var path = std.mem.trim(u8, value, " \t\r\n\"'");
    if (std.mem.startsWith(u8, path, "file://")) path = path[7..];

    if (std.mem.startsWith(u8, path, repo)) {
        if (path.len > repo.len and (path[repo.len] == '/' or path[repo.len] == '\\')) {
            path = path[repo.len + 1 ..];
        }
    } else if (path.len > 0 and (path[0] == '/' or std.mem.indexOf(u8, path, ":\\") != null)) {
        return null;
    }

    while (std.mem.startsWith(u8, path, "./")) path = path[2..];
    if (!isSafeRelativePath(path)) return null;
    return allocator.dupe(u8, path) catch null;
}

fn patchStatsMap(allocator: std.mem.Allocator, patch_text: []const u8, repo: []const u8) !std.StringHashMap(LineStats) {
    var stats = std.StringHashMap(LineStats).init(allocator);
    var current_file: ?[]const u8 = null;
    var saw_unified_header = false;

    var lines = std.mem.splitScalar(u8, patch_text, '\n');
    while (lines.next()) |raw_line| {
        const line = std.mem.trim(u8, raw_line, "\r");

        if (fileFromApplyPatchMarker(allocator, line, repo)) |file| {
            current_file = file;
            try ensureStats(allocator, &stats, file);
            continue;
        }

        if (fileFromDiffGit(allocator, line, repo)) |file| {
            current_file = file;
            try ensureStats(allocator, &stats, file);
            continue;
        }

        if (std.mem.startsWith(u8, line, "+++ ")) {
            if (fileFromUnifiedHeader(allocator, line[4..], repo)) |file| {
                current_file = file;
                saw_unified_header = true;
                try ensureStats(allocator, &stats, file);
            }
            continue;
        }

        if (std.mem.startsWith(u8, line, "--- ") or std.mem.startsWith(u8, line, "@@")) continue;

        if (current_file) |file| {
            if (line.len > 0 and line[0] == '+' and !std.mem.startsWith(u8, line, "+++")) {
                try addStats(allocator, &stats, file, 1, 0);
            } else if (line.len > 0 and line[0] == '-' and !std.mem.startsWith(u8, line, "---")) {
                try addStats(allocator, &stats, file, 0, 1);
            }
        }
    }

    if (!saw_unified_header and stats.count() == 0) {
        try extractPatchFileMentions(allocator, patch_text, repo, &stats);
    }

    return stats;
}

fn fileFromApplyPatchMarker(allocator: std.mem.Allocator, line: []const u8, repo: []const u8) ?[]const u8 {
    const prefixes = [_][]const u8{
        "*** Update File: ",
        "*** Add File: ",
        "*** Delete File: ",
        "*** Rename From: ",
        "*** Rename To: ",
    };
    for (prefixes) |prefix| {
        if (std.mem.startsWith(u8, line, prefix)) return normalizePath(allocator, line[prefix.len..], repo);
    }
    return null;
}

fn fileFromDiffGit(allocator: std.mem.Allocator, line: []const u8, repo: []const u8) ?[]const u8 {
    if (!std.mem.startsWith(u8, line, "diff --git ")) return null;
    if (std.mem.indexOf(u8, line, " b/")) |index| return normalizePath(allocator, line[index + 3 ..], repo);
    return null;
}

fn fileFromUnifiedHeader(allocator: std.mem.Allocator, header: []const u8, repo: []const u8) ?[]const u8 {
    var value = std.mem.trim(u8, header, " \t\r\n");
    if (std.mem.eql(u8, value, "/dev/null")) return null;
    if (std.mem.startsWith(u8, value, "a/") or std.mem.startsWith(u8, value, "b/")) value = value[2..];
    return normalizePath(allocator, value, repo);
}

fn extractPatchFileMentions(
    allocator: std.mem.Allocator,
    patch_text: []const u8,
    repo: []const u8,
    stats: *std.StringHashMap(LineStats),
) !void {
    var lines = std.mem.splitScalar(u8, patch_text, '\n');
    while (lines.next()) |line| {
        if (fileFromApplyPatchMarker(allocator, line, repo)) |file| try ensureStats(allocator, stats, file);
        if (fileFromDiffGit(allocator, line, repo)) |file| try ensureStats(allocator, stats, file);
    }
}

fn ensureStats(allocator: std.mem.Allocator, stats: *std.StringHashMap(LineStats), file: []const u8) !void {
    if (stats.contains(file)) return;
    try stats.put(try allocator.dupe(u8, file), .{});
}

fn addStats(allocator: std.mem.Allocator, stats: *std.StringHashMap(LineStats), file: []const u8, added: usize, deleted: usize) !void {
    if (stats.getPtr(file)) |entry| {
        entry.added += added;
        entry.deleted += deleted;
        return;
    }
    try stats.put(try allocator.dupe(u8, file), .{ .added = added, .deleted = deleted });
}

fn editTextStats(allocator: std.mem.Allocator, bytes: []const u8) LineStats {
    const old_text = findFirstJsonStringValue(allocator, bytes, &.{ "oldText", "old_string", "oldString", "old", "find", "search" });
    const new_text = findFirstJsonStringValue(allocator, bytes, &.{ "newText", "new_string", "newString", "new", "replace", "replacement", "content" });

    const old_lines = if (old_text) |text| countLines(text) else 0;
    const new_lines = if (new_text) |text| countLines(text) else 0;

    if (new_lines > old_lines) return .{ .added = new_lines - old_lines, .deleted = 0 };
    if (old_lines > new_lines) return .{ .added = 0, .deleted = old_lines - new_lines };
    return .{};
}

fn countLines(text: []const u8) usize {
    if (text.len == 0) return 0;
    var count: usize = 1;
    for (text) |byte| {
        if (byte == '\n') count += 1;
    }
    if (text[text.len - 1] == '\n' and count > 0) count -= 1;
    return count;
}

fn extractPatchPayload(allocator: std.mem.Allocator, bytes: []const u8) ?[]const u8 {
    const keys = [_][]const u8{ "patch", "diff", "input", "cmd", "arguments" };
    for (keys) |key| {
        if (findJsonStringValueAlloc(allocator, bytes, key)) |value| {
            if (containsPatchText(value)) {
                if (std.mem.eql(u8, key, "arguments")) {
                    if (extractPatchPayload(allocator, value)) |nested| return nested;
                }
                return value;
            }

            if (std.mem.eql(u8, key, "arguments")) {
                if (extractPatchPayload(allocator, value)) |nested| return nested;
            }
        }
    }

    if (containsPatchText(bytes)) return allocator.dupe(u8, bytes) catch null;
    return null;
}

fn containsPatchText(bytes: []const u8) bool {
    return std.mem.indexOf(u8, bytes, "*** Begin Patch") != null or
        std.mem.indexOf(u8, bytes, "*** Update File:") != null or
        std.mem.indexOf(u8, bytes, "*** Add File:") != null or
        std.mem.indexOf(u8, bytes, "diff --git") != null or
        std.mem.indexOf(u8, bytes, "+++ ") != null;
}

fn lineIsAfterSince(allocator: std.mem.Allocator, line: []const u8, since_ns: i96) bool {
    const timestamp = findJsonStringValueAlloc(allocator, line, "timestamp") orelse return true;
    const line_ns = parseIsoTimestampNs(timestamp) catch return true;
    return line_ns >= since_ns;
}

fn findFirstJsonStringValue(allocator: std.mem.Allocator, bytes: []const u8, keys: []const []const u8) ?[]const u8 {
    for (keys) |key| {
        if (findJsonStringValueAlloc(allocator, bytes, key)) |value| return value;
    }
    return null;
}

fn findJsonStringValueAlloc(allocator: std.mem.Allocator, bytes: []const u8, key: []const u8) ?[]const u8 {
    const pattern = std.fmt.allocPrint(allocator, "\"{s}\"", .{key}) catch return null;
    var index: usize = 0;

    while (std.mem.indexOfPos(u8, bytes, index, pattern)) |match| {
        var cursor = match + pattern.len;
        while (cursor < bytes.len and (bytes[cursor] == ' ' or bytes[cursor] == '\t' or bytes[cursor] == '\r' or bytes[cursor] == '\n')) cursor += 1;
        if (cursor >= bytes.len or bytes[cursor] != ':') {
            index = match + pattern.len;
            continue;
        }
        cursor += 1;
        while (cursor < bytes.len and (bytes[cursor] == ' ' or bytes[cursor] == '\t' or bytes[cursor] == '\r' or bytes[cursor] == '\n')) cursor += 1;
        if (cursor >= bytes.len or bytes[cursor] != '"') {
            index = match + pattern.len;
            continue;
        }
        return parseJsonStringAt(allocator, bytes, cursor) catch null;
    }

    return null;
}

fn parseJsonStringAt(allocator: std.mem.Allocator, bytes: []const u8, quote_index: usize) ![]const u8 {
    if (quote_index >= bytes.len or bytes[quote_index] != '"') return error.InvalidJson;

    var out: std.ArrayList(u8) = .empty;
    var index = quote_index + 1;

    while (index < bytes.len) : (index += 1) {
        const byte = bytes[index];
        if (byte == '"') return try out.toOwnedSlice(allocator);

        if (byte != '\\') {
            try out.append(allocator, byte);
            continue;
        }

        index += 1;
        if (index >= bytes.len) return error.InvalidJson;
        const escaped = bytes[index];
        switch (escaped) {
            '"' => try out.append(allocator, '"'),
            '\\' => try out.append(allocator, '\\'),
            '/' => try out.append(allocator, '/'),
            'n' => try out.append(allocator, '\n'),
            'r' => try out.append(allocator, '\r'),
            't' => try out.append(allocator, '\t'),
            'b' => try out.append(allocator, 8),
            'f' => try out.append(allocator, 12),
            'u' => {
                try out.append(allocator, '?');
                index += 4;
                if (index >= bytes.len) return error.InvalidJson;
            },
            else => try out.append(allocator, escaped),
        }
    }

    return error.InvalidJson;
}

fn lineHasJsonString(line: []const u8, key: []const u8, value: []const u8) bool {
    return containsCompactJsonPair(line, key, value) or containsSpacedJsonPair(line, key, value);
}

fn containsCompactJsonPair(line: []const u8, key: []const u8, value: []const u8) bool {
    var buffer: [256]u8 = undefined;
    const pattern = std.fmt.bufPrint(&buffer, "\"{s}\":\"{s}\"", .{ key, value }) catch return false;
    return std.mem.indexOf(u8, line, pattern) != null;
}

fn containsSpacedJsonPair(line: []const u8, key: []const u8, value: []const u8) bool {
    var buffer: [256]u8 = undefined;
    const pattern = std.fmt.bufPrint(&buffer, "\"{s}\": \"{s}\"", .{ key, value }) catch return false;
    return std.mem.indexOf(u8, line, pattern) != null;
}

fn hasEditEvidence(bytes: []const u8) bool {
    const needles = [_][]const u8{
        "\"name\":\"edit\"",
        "\"name\": \"edit\"",
        "\"name\":\"write\"",
        "\"name\": \"write\"",
        "\"name\":\"apply_patch\"",
        "\"name\": \"apply_patch\"",
        "\"toolName\":\"edit\"",
        "\"toolName\": \"edit\"",
        "\"tool_name\":\"Edit\"",
        "\"tool_name\": \"Edit\"",
        "\"tool_name\":\"Write\"",
        "\"tool_name\": \"Write\"",
        "*** Begin Patch",
        "diff --git",
    };

    for (needles) |needle| {
        if (std.mem.indexOf(u8, bytes, needle) != null) return true;
    }

    return false;
}

fn isEditTool(tool_name: []const u8) bool {
    return std.mem.eql(u8, tool_name, "edit") or
        std.mem.eql(u8, tool_name, "write") or
        std.mem.eql(u8, tool_name, "apply_patch") or
        std.mem.eql(u8, tool_name, "str_replace") or
        std.mem.eql(u8, tool_name, "replace") or
        std.mem.eql(u8, tool_name, "create_file") or
        std.mem.eql(u8, tool_name, "delete_file") or
        std.mem.eql(u8, tool_name, "Edit") or
        std.mem.eql(u8, tool_name, "Write") or
        std.mem.eql(u8, tool_name, "MultiEdit") or
        std.mem.eql(u8, tool_name, "NotebookEdit");
}

fn kindForTool(tool_name: []const u8) []const u8 {
    if (std.mem.indexOf(u8, tool_name, "patch") != null) return "apply_patch";
    if (std.mem.indexOf(u8, tool_name, "Multi") != null or std.mem.indexOf(u8, tool_name, "multi") != null) return "multi_edit";
    if (std.mem.indexOf(u8, tool_name, "Write") != null or std.mem.indexOf(u8, tool_name, "write") != null or std.mem.indexOf(u8, tool_name, "create") != null) return "write";
    if (std.mem.indexOf(u8, tool_name, "delete") != null or std.mem.indexOf(u8, tool_name, "Delete") != null) return "delete";
    return "edit";
}

fn stripFunctionsPrefix(name: []const u8) []const u8 {
    const prefix = "functions.";
    if (std.mem.startsWith(u8, name, prefix)) return name[prefix.len..];
    return name;
}

fn renderSession(allocator: std.mem.Allocator, agent: Agent, session_hash: []const u8, result: *ScanResult) ![]const u8 {
    var out: std.ArrayList(u8) = .empty;
    try out.appendSlice(allocator, "{\"source\":");
    try appendJsonString(allocator, &out, agentName(agent));
    try out.appendSlice(allocator, ",\"pathHash\":\"sha256:");
    try out.appendSlice(allocator, session_hash);
    try out.appendSlice(allocator, "\",\"filesMentioned\":[");

    var file_iterator = result.files.keyIterator();
    var file_index: usize = 0;
    while (file_iterator.next()) |file| {
        if (file_index > 0) try out.appendSlice(allocator, ",");
        try appendJsonString(allocator, &out, file.*);
        file_index += 1;
    }

    try out.appendSlice(allocator, "],\"commandsSeen\":[],\"editEvents\":[");
    for (result.events.items, 0..) |event, index| {
        if (index > 0) try out.appendSlice(allocator, ",");
        try renderEvent(allocator, &out, event);
    }

    try out.appendSlice(
        allocator,
        try std.fmt.allocPrint(allocator, "],\"confidence\":{d:.2}}}", .{sessionConfidence(agent, result)}),
    );

    return try out.toOwnedSlice(allocator);
}

fn renderEvent(allocator: std.mem.Allocator, out: *std.ArrayList(u8), event: EditEvent) !void {
    try out.appendSlice(allocator, "{\"agent\":");
    try appendJsonString(allocator, out, agentName(event.agent));
    try out.appendSlice(allocator, ",\"kind\":");
    try appendJsonString(allocator, out, event.kind);
    try out.appendSlice(allocator, ",\"file\":");
    try appendJsonString(allocator, out, event.file);

    if (event.timestamp) |timestamp| {
        try out.appendSlice(allocator, ",\"timestamp\":");
        try appendJsonString(allocator, out, timestamp);
    }

    if (event.call_id) |call_id| {
        try out.appendSlice(allocator, ",\"callId\":");
        try appendJsonString(allocator, out, call_id);
    }

    try out.appendSlice(
        allocator,
        try std.fmt.allocPrint(allocator, ",\"confidence\":{d:.2},\"evidence\":{{\"source\":", .{event.confidence}),
    );
    try appendJsonString(allocator, out, event.source);

    if (event.tool_name) |tool_name| {
        try out.appendSlice(allocator, ",\"toolName\":");
        try appendJsonString(allocator, out, tool_name);
    }

    try out.appendSlice(allocator, ",\"sessionFileHash\":\"sha256:");
    try out.appendSlice(allocator, event.session_hash);
    try out.appendSlice(allocator, "\"}");

    if (event.patch_hash) |patch_hash| {
        try out.appendSlice(allocator, ",\"patchHash\":\"sha256:");
        try out.appendSlice(allocator, patch_hash);
        try out.appendSlice(allocator, "\"");
    }

    try out.appendSlice(
        allocator,
        try std.fmt.allocPrint(
            allocator,
            ",\"stats\":{{\"added\":{d},\"deleted\":{d}}}}}",
            .{ event.stats.added, event.stats.deleted },
        ),
    );
}

fn appendJsonString(allocator: std.mem.Allocator, out: *std.ArrayList(u8), value: []const u8) !void {
    try out.append(allocator, '"');
    for (value) |byte| {
        switch (byte) {
            '"' => try out.appendSlice(allocator, "\\\""),
            '\\' => try out.appendSlice(allocator, "\\\\"),
            '\n' => try out.appendSlice(allocator, "\\n"),
            '\r' => try out.appendSlice(allocator, "\\r"),
            '\t' => try out.appendSlice(allocator, "\\t"),
            else => try out.append(allocator, byte),
        }
    }
    try out.append(allocator, '"');
}

fn sessionConfidence(agent: Agent, result: *ScanResult) f32 {
    if (result.events.items.len == 0) return confidenceForAgent(agent, false);

    var total: f32 = 0;
    for (result.events.items) |event| total += event.confidence;
    return total / @as(f32, @floatFromInt(result.events.items.len));
}

fn confidenceForAgent(agent: Agent, edit: bool) f32 {
    if (!edit) {
        return switch (agent) {
            .pi, .codex => 0.45,
            .claude => 0.40,
            .cursor_cli, .droid, .generic => 0.25,
        };
    }

    return switch (agent) {
        .pi, .codex => 0.90,
        .claude => 0.85,
        .cursor_cli => 0.55,
        .droid, .generic => 0.45,
    };
}

fn isPathTerminator(byte: u8) bool {
    return byte == '"' or byte == '\'' or byte == '\n' or byte == '\r' or byte == '\t' or byte == ' ';
}

fn isSafeRelativePath(path: []const u8) bool {
    if (path.len == 0 or path[0] == '/' or std.mem.indexOf(u8, path, "..") != null) return false;
    if (std.mem.eql(u8, path, ".") or std.mem.eql(u8, path, "./")) return false;
    if (std.mem.startsWith(u8, path, ".percentvibed/")) return false;
    if (std.mem.indexOfScalar(u8, path, '"') != null or std.mem.indexOfScalar(u8, path, '\\') != null) return false;
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
