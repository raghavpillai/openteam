import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CapabilitySettingsStore } from "../../src/main/host/capability-settings";
import {
  OnePasswordProvisioning,
  brokerCredentialCommand,
} from "../../src/main/host/onepassword-provisioning";
import { SavedCredentials } from "../../src/main/host/credentials";
