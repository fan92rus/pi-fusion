// gate-check-gd: gateDecision-уровень gate-теста (tasks 8.8 (e1)/(e3): «проходит
// gateDecision-тест (8.7)»). Регистрирует настоящий гейт через
// registerLeadRestrictions на fake-pi (как в компонентных тестах 8.7) и
// пропускает строку через перехваченный tool_call-хук.
// Вызов: node --experimental-strip-types harness/gate-check-gd.mts '<строка>' …
import { registerLeadRestrictions } from "file:///D:/Documents/Repositories/pi-fusion/extensions/pi-fusion/restrictions.ts";

const T = "C:/Users/user/AppData/Local/Temp/fusion-bd-leadr9-20261102-160648";

type Handler = (event: { toolName: string; input: unknown }, ctx?: unknown) => unknown;
let toolCall: Handler | undefined;
const fakePi = {
  on(event: string, fn: Handler) {
    if (event === "tool_call") toolCall = fn;
  },
};

// Hermetic shell-контекст (как 8.7): все чтения настроек ENOENT → стоковая
// оболочка; агент-каталог и projectRoot указывают в изолированные каталоги T.
const hermeticReadFile = (p: unknown): string => {
  const e = new Error(`ENOENT: no such file or directory, open '${String(p)}'`) as NodeJS.ErrnoException;
  e.code = "ENOENT";
  throw e;
};

registerLeadRestrictions(fakePi as never, {
  isEnabled: () => true,
  isLeadSession: () => true,
  agentDir: () => `${T}/agent-dir`,
  projectRoot: () => `${T}/proj`,
  shellSettingsContext: () => ({
    env: { HOME: "C:\\Users\\user", USERPROFILE: "C:\\Users\\user" },
    homedir: () => "C:\\Users\\user",
    platform: "win32",
    readFile: hermeticReadFile,
  }),
} as never);

if (toolCall === undefined) {
  console.error("FAIL: tool_call handler not registered");
  process.exit(1);
}

const argv = process.argv.slice(2);
const raw = argv.length === 1 && argv[0].endsWith(".json")
  ? await import("node:fs").then((fs) => fs.readFileSync(argv[0], "utf8"))
  : null;
const parsed = raw === null ? null : (JSON.parse(raw) as unknown);
const lines = parsed === null ? argv : Array.isArray(parsed) ? (parsed as string[]) : ((parsed as { lines?: string[] }).lines ?? []);
let allOk = true;
for (const line of lines) {
  const result = toolCall({ toolName: "bash", input: { command: line } }, undefined);
  const allowed = result === undefined;
  console.log(`${allowed ? "PASS(allow)" : "FAIL(block)"} ${JSON.stringify(line)}`);
  if (!allowed) {
    console.log(`  reason: ${JSON.stringify(result)}`);
    allOk = false;
  }
}
process.exit(allOk ? 0 : 1);
