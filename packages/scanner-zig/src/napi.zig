const std = @import("std");
const scanner = @import("main.zig");

const napi = struct {
    pub const env = ?*opaque {};
    pub const value = ?*opaque {};
    pub const callback_info = ?*opaque {};
    pub const status = enum(c_int) {
        ok = 0,
        invalid_arg = 1,
        object_expected = 2,
        string_expected = 3,
        name_expected = 4,
        function_expected = 5,
        number_expected = 6,
        boolean_expected = 7,
        array_expected = 8,
        generic_failure = 9,
        pending_exception = 10,
        cancelled = 11,
        escape_called_twice = 12,
        handle_scope_mismatch = 13,
        callback_scope_mismatch = 14,
        queue_full = 15,
        closing = 16,
        bigint_expected = 17,
        date_expected = 18,
        arraybuffer_expected = 19,
        detachable_arraybuffer_expected = 20,
        would_deadlock = 21,
        no_external_buffers_allowed = 22,
        _ ,
    };

    pub const callback = ?*const fn (env: env, info: callback_info) callconv(.c) value;

    pub const property_descriptor = extern struct {
        utf8name: ?[*:0]const u8,
        name: value,
        method: callback,
        getter: callback,
        setter: callback,
        value: value,
        attributes: c_int,
        data: ?*anyopaque,
    };

    extern fn napi_get_cb_info(env: env, cbinfo: callback_info, argc: *usize, argv: [*]value, this_arg: ?*value, data: ?*?*anyopaque) callconv(.c) status;
    extern fn napi_get_value_string_utf8(env: env, value: value, buf: ?[*]u8, bufsize: usize, result: *usize) callconv(.c) status;
    extern fn napi_create_string_utf8(env: env, str: [*]const u8, length: usize, result: *value) callconv(.c) status;
    extern fn napi_define_properties(env: env, object: value, property_count: usize, properties: [*]const property_descriptor) callconv(.c) status;
    extern fn napi_throw_type_error(env: env, code: ?[*:0]const u8, msg: [*:0]const u8) callconv(.c) status;
    extern fn napi_throw_error(env: env, code: ?[*:0]const u8, msg: [*:0]const u8) callconv(.c) status;

    pub fn check(result: status) !void {
        if (result != .ok) return error.NapiFailure;
    }
};

export fn node_api_module_get_api_version_v1() c_int {
    return 8;
}

export fn napi_register_module_v1(env: napi.env, exports: napi.value) callconv(.c) napi.value {
    const descriptors = [_]napi.property_descriptor{
        .{
            .utf8name = "scan",
            .name = null,
            .method = scanCallback,
            .getter = null,
            .setter = null,
            .value = null,
            .attributes = 0,
            .data = null,
        },
    };

    napi.check(napi.napi_define_properties(env, exports, descriptors.len, &descriptors)) catch {
        throwError(env, "failed to initialize native scanner");
    };

    return exports;
}

fn scanCallback(env: napi.env, info: napi.callback_info) callconv(.c) napi.value {
    var arena_state = std.heap.ArenaAllocator.init(std.heap.page_allocator);
    defer arena_state.deinit();
    const allocator = arena_state.allocator();

    var argc: usize = 4;
    var argv: [4]napi.value = undefined;
    napi.check(napi.napi_get_cb_info(env, info, &argc, argv[0..].ptr, null, null)) catch {
        throwTypeError(env, "failed to read scanner arguments");
        return null;
    };

    if (argc < 2) {
        throwTypeError(env, "scan(repo, since, home, scanDirs) requires repo and since strings");
        return null;
    }

    const repo = valueToString(env, argv[0], allocator) catch {
        throwTypeError(env, "scan repo must be a string");
        return null;
    };
    const since = valueToString(env, argv[1], allocator) catch {
        throwTypeError(env, "scan since must be a string");
        return null;
    };
    const home = if (argc > 2) valueToString(env, argv[2], allocator) catch "" else "";
    const scan_dirs = if (argc > 3) valueToString(env, argv[3], allocator) catch "" else "";

    const io = std.Io.Threaded.global_single_threaded.io();
    const json = scanner.scanToJson(
        allocator,
        io,
        repo,
        since,
        if (scan_dirs.len == 0) null else scan_dirs,
        if (home.len == 0) null else home,
    ) catch |err| {
        throwScanError(env, err);
        return null;
    };

    var result: napi.value = null;
    napi.check(napi.napi_create_string_utf8(env, json.ptr, json.len, &result)) catch {
        throwError(env, "failed to return scanner JSON");
        return null;
    };

    return result;
}

fn valueToString(env: napi.env, value: napi.value, allocator: std.mem.Allocator) ![]const u8 {
    var len: usize = 0;
    try napi.check(napi.napi_get_value_string_utf8(env, value, null, 0, &len));

    const buffer = try allocator.alloc(u8, len + 1);
    var written: usize = 0;
    try napi.check(napi.napi_get_value_string_utf8(env, value, buffer.ptr, buffer.len, &written));
    return buffer[0..written];
}

fn throwTypeError(env: napi.env, message: []const u8) void {
    var buffer: [512]u8 = undefined;
    const z_message = std.fmt.bufPrintZ(&buffer, "{s}", .{message}) catch "native scanner argument error";
    _ = napi.napi_throw_type_error(env, null, z_message.ptr);
}

fn throwError(env: napi.env, message: []const u8) void {
    var buffer: [512]u8 = undefined;
    const z_message = std.fmt.bufPrintZ(&buffer, "{s}", .{message}) catch "native scanner error";
    _ = napi.napi_throw_error(env, null, z_message.ptr);
}

fn throwScanError(env: napi.env, err: anyerror) void {
    var buffer: [512]u8 = undefined;
    const z_message = std.fmt.bufPrintZ(&buffer, "native scanner failed: {s}", .{@errorName(err)}) catch "native scanner failed";
    _ = napi.napi_throw_error(env, null, z_message.ptr);
}
