const std = @import("std");

pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{});

    const addon = b.addLibrary(.{
        .name = "percentvibed_scanner",
        .linkage = .dynamic,
        .root_module = b.createModule(.{
            .root_source_file = b.path("src/napi.zig"),
            .target = target,
            .optimize = optimize,
        }),
    });
    addon.linker_allow_shlib_undefined = true;

    const install_addon = b.addInstallFile(addon.getEmittedBin(), "percentvibed_scanner.node");
    b.getInstallStep().dependOn(&install_addon.step);

    const build_cli = b.option(bool, "cli", "Build the legacy percentvibed-scan executable") orelse false;
    if (build_cli) {
        const exe = b.addExecutable(.{
            .name = "percentvibed-scan",
            .root_module = b.createModule(.{
                .root_source_file = b.path("src/main.zig"),
                .target = target,
                .optimize = optimize,
            }),
        });

        b.installArtifact(exe);
    }
}
