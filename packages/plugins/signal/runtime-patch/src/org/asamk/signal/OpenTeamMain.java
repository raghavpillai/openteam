// OpenTeam-authored compatibility launcher. GPL-3.0-only.
package org.asamk.signal;

public final class OpenTeamMain {
    public static final String PATCH_VERSION = "0.14.10-ot.1";

    public static void main(String[] args) throws Exception {
        // Read the upstream JAR itself: package metadata can come from this earlier overlay.
        var upstream = java.nio.file.Path.of(Main.class.getProtectionDomain().getCodeSource().getLocation().toURI());
        try (var jar = new java.util.jar.JarFile(upstream.toFile())) {
            if (!"0.14.10".equals(jar.getManifest().getMainAttributes().getValue("Implementation-Version")))
                throw new IllegalStateException("Signal compatibility patch requires signal-cli 0.14.10");
        }
        // Fail at startup if classpath ordering or a runtime upgrade loses the patch.
        var field = org.asamk.signal.manager.api.MessageEnvelope.Sync.class.getMethod("deleteForMe");
        if (!field.getReturnType().equals(java.util.Optional.class))
            throw new IllegalStateException("Signal deletion compatibility patch is unavailable");
        if (args.length == 1 && args[0].equals("--openteam-patch-version")) {
            System.out.println(PATCH_VERSION);
            return;
        }
        org.asamk.signal.Main.main(args);
    }
}
