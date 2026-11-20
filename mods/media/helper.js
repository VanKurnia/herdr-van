// The helper process: started once as a hidden background process, reused if it is already there,
// and killed when the row goes away or the window closes.
import { appHome, exec } from "herdr";

const RETRY_MS = 20000; // wait after a failed launch, doubling
const RETRY_MAX_MS = 300000; // then keep trying slowly: dependencies can arrive later
export const backoffMs = (failures) => Math.min(RETRY_MS * 2 ** failures, RETRY_MAX_MS);

// Resolves with what launch.ps1 printed: { pid } when it started or found one, else { why }.
// It never throws: a failed launch is the row's "why it is empty", not an exception.
export async function startHelper() {
  const dir = `${appHome()}/mods/media`;
  const args = [
    "-NoProfile",
    "-ExecutionPolicy", "Bypass",
    "-File", `${dir}/launch.ps1`,
    "-AppHome", appHome(),
    "-ModDir", dir,
  ];
  try {
    const out = await exec("powershell", args, { timeout: 20000 });
    const printed = (out.stdout ?? "").trim();
    if (/^\d+$/.test(printed)) return { pid: Number(printed), why: null };
    return { pid: null, why: printed || "(no output)" };
  } catch (err) {
    return { pid: null, why: err?.message ?? String(err) };
  }
}

// The caller owns the pid: it passes the old value in and clears its own first.
export async function stopHelper(pid) {
  try {
    if (pid) await exec("taskkill", ["/PID", String(pid), "/T", "/F"], { timeout: 5000 });
    // A reload drops the pid. There is one helper per app home, so find it by what it runs.
    else {
      const find = [
        "Get-CimInstance Win32_Process -Filter \"Name='pythonw.exe' OR Name='python.exe'\"",
        `| Where-Object { $_.CommandLine -like '*helper.py*' -and $_.CommandLine -like '*${appHome()}*' }`,
        "| ForEach-Object { Stop-Process -Id $_.ProcessId -Force }",
      ].join(" ");
      await exec("powershell", ["-NoProfile", "-Command", find], { timeout: 15000 });
    }
  } catch {
    // Already gone, or it cannot be reached: a stale beat stops it within BEAT_STALE_S.
  }
}
