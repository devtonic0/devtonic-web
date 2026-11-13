import { useEffect, useState } from "react";
import { loadMissionAsync, bus } from "../store.js";

/**
 * Mission state for a panel, loaded with fs.promises (no sync XHR).
 *
 * Starts as `null` until the first async load resolves, reloads on project
 * switch, and follows in-app edits via the "mission" bus event. A load that
 * finishes after a newer one started (fast project switching) or after the
 * panel unmounted is dropped, so stale data never overwrites fresh state.
 *
 * @param onProject  optional callback fired on project switch (e.g. clear selection)
 * @returns [mission | null, setMission]
 */
export function useMission(onProject) {
  const [mission, setMission] = useState(null);
  useEffect(() => {
    let live = true, seq = 0;
    const load = root => {
      const my = ++seq;
      loadMissionAsync(root).then(m => { if (live && my === seq) setMission(m); });
    };
    load();
    const offProject = bus.on("project", root => { onProject?.(); load(root); });
    const offMission = bus.on("mission", m => { seq++; setMission({ ...m }); });
    return () => { live = false; offProject(); offMission(); };
    // onProject is a mount-time callback; panels pass a stable setter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return [mission, setMission];
}
