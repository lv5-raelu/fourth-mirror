export async function waitForStatus(control, predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  do {
    const status = await control('/status');
    if (predicate(status)) return status;
    if (status.blocked) throw new Error('Discord Gateway is blocked: ' + status.blocked + '. Fix the configuration before restarting.');
    await new Promise(resolve => setTimeout(resolve, 250));
  } while (Date.now() < deadline);
  throw new Error('Timed out waiting for ' + label + '. Check cloudflare:control -- status.');
}

export async function performUpdate({ check, access, control, backup, deploy, report = () => {}, wait = waitForStatus }) {
  await check();
  await access();
  await control('/status');
  let resumeOnFailure = false, deployed = false;
  try {
    // A lost drain response might still have stopped the bot. Attempt recovery on that path too.
    resumeOnFailure = true;
    await control('/drain', 'POST');
    await wait(control, status => !status.active && !status.running, 25_000, 'drain');
    await backup(await control('/history'));
    await deploy(); deployed = true;
    await control('/start', 'POST');
    const healthy = await wait(control, status => status.ready && status.lastAckAt > 0, 150_000, 'Gateway readiness');
    resumeOnFailure = false;
    return healthy;
  } catch (error) {
    if (resumeOnFailure && !deployed) {
      try { await control('/start', 'POST'); report('Restart requested for the existing deployment after the update failed.'); }
      catch { report('Could not confirm a restart. Check status and run cloudflare:control -- start after any drain finishes.'); }
    } else if (deployed) report('Code was deployed, but readiness could not be verified. Check status and configuration before retrying.');
    throw error;
  }
}
