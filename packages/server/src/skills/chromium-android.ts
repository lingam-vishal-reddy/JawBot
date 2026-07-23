import type { Skill } from "@jawbot/shared";

/**
 * Built-in example skill supplied as plain-text context: how to set up and
 * build Chromium for Android on this Linux machine.
 *
 * The `context` is the plain-language playbook the planner reads. The `tasks`
 * turn that playbook into runnable, trackable work (setup, build) that the
 * user can trigger and get status updates on.
 *
 * Paths follow Chromium's documented Android build flow. `CHROMIUM_SRC`
 * (default ~/chromium/src) lets an operator point at an existing checkout.
 */
const CHROMIUM_ROOT = "${CHROMIUM_ROOT:-$HOME/chromium}";
const CHROMIUM_SRC = "${CHROMIUM_SRC:-$HOME/chromium/src}";
const DEPOT_TOOLS = "${DEPOT_TOOLS:-$HOME/depot_tools}";
const PATH_WITH_DEPOT = `export PATH="${DEPOT_TOOLS}:$PATH"`;

export const chromiumAndroidSkill: Skill = {
  id: "chromium-android",
  name: "Chromium Android",
  description:
    "Set up depot_tools + a Chromium checkout and build Chromium for Android.",
  triggers: ["chromium", "chrome android", "chromium android"],
  context: `Skill: Chromium for Android (plain-text playbook)

Goal: fetch depot_tools, check out Chromium source configured for Android, and
build the "chrome_public_apk" target.

Assumptions / environment:
- Linux host with git, python3, and enough disk (Chromium needs 100GB+).
- depot_tools lives at ${DEPOT_TOOLS} and must be on PATH.
- Chromium source lives at ${CHROMIUM_SRC}.
- Override with CHROMIUM_ROOT, CHROMIUM_SRC, DEPOT_TOOLS env vars.

Setup (task "setup"):
1. Clone depot_tools if missing.
2. Create the Chromium root and 'fetch' the Android-flavored checkout.
3. Run build/install-build-deps.sh (Android) and 'gclient sync'.

Build (task "build"):
1. Generate args (target_os="android") with 'gn gen'.
2. Compile chrome_public_apk with autoninja.
The resulting APK lands in out/Android/apks/.

Status: setup and build run step by step; ask "status" for progress.`,
  tasks: [
    {
      id: "setup",
      name: "Chromium Android setup",
      description:
        "Install depot_tools and fetch/sync a Chromium Android checkout.",
      triggers: ["setup", "set up", "install", "fetch", "prepare", "sync"],
      steps: [
        {
          name: "Clone depot_tools",
          command: `if [ ! -d "${DEPOT_TOOLS}" ]; then git clone https://chromium.googlesource.com/chromium/tools/depot_tools.git "${DEPOT_TOOLS}"; else echo "depot_tools already present"; fi`,
          timeoutMs: 600_000,
        },
        {
          name: "Fetch Chromium (Android)",
          command: `${PATH_WITH_DEPOT}; mkdir -p "${CHROMIUM_ROOT}"; cd "${CHROMIUM_ROOT}"; if [ ! -d "${CHROMIUM_SRC}/.git" ]; then fetch --nohooks android; else echo "chromium checkout already present"; fi`,
          timeoutMs: 3_600_000,
        },
        {
          name: "Install build deps",
          command: `${PATH_WITH_DEPOT}; cd "${CHROMIUM_SRC}"; ./build/install-build-deps.sh --android || true`,
          timeoutMs: 1_800_000,
        },
        {
          name: "gclient sync",
          command: `${PATH_WITH_DEPOT}; cd "${CHROMIUM_SRC}"; gclient sync`,
          timeoutMs: 3_600_000,
        },
      ],
    },
    {
      id: "build",
      name: "Chromium Android build",
      description: "Configure GN args for Android and build chrome_public_apk.",
      triggers: ["build", "compile", "make", "apk"],
      steps: [
        {
          name: "gn gen (Android)",
          command: `${PATH_WITH_DEPOT}; cd "${CHROMIUM_SRC}"; gn gen out/Android --args='target_os="android" is_debug=false'`,
          timeoutMs: 600_000,
        },
        {
          name: "autoninja chrome_public_apk",
          command: `${PATH_WITH_DEPOT}; cd "${CHROMIUM_SRC}"; autoninja -C out/Android chrome_public_apk`,
          timeoutMs: 14_400_000,
        },
      ],
    },
  ],
};
