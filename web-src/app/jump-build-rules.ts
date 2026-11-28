// Jump and a running Build, as plain decisions (build-ops-ui.ts applies them).

/**
 * Whether the Jump button can be pressed. While a Build runs, Jump answers
 * for the paper on screen: the Live paper, which goes on being typeset, or
 * the previous Build's PDF, which stays in place with its SyncTeX until the
 * Build swaps in the new one at its very end. With neither (a first Build)
 * there is nothing to answer for, so it waits. Saving before a Build is brief.
 */
export const jumpButtonEnabled = ({ hasTarget, preparingBuild, building, previousPdf, livePaper }: {
  hasTarget: boolean;
  preparingBuild: boolean;
  building: boolean;
  previousPdf: boolean;
  livePaper: boolean;
}) => hasTarget && !preparingBuild && (!building || previousPdf || livePaper);

/**
 * A Jump made while the Build ran already moved the paper, and a Jump that
 * started the Build is about to: no second, automatic one.
 */
export const autoJumpAfterBuild = ({ enabled, jumpedDuringBuild, jumpFollowsBuild = false }: {
  enabled: boolean;
  jumpedDuringBuild: boolean;
  jumpFollowsBuild?: boolean;
}) => enabled && !jumpedDuringBuild && !jumpFollowsBuild;

/**
 * What a Jump whose document has no PDF yet does.
 *  - "notice": this Jump already followed a Build that left none (another
 *    Build would end the same way).
 *  - "follow": a Build is running already; the Jump follows it.
 *  - "build": start the Build, then jump. With no target named, the Build
 *    resolves the document from the active file, as the Build button does.
 */
export const needsBuildAction = ({ afterBuild, building }: {
  afterBuild: boolean;
  building: boolean;
  targetFile?: string;
}): "notice" | "follow" | "build" => {
  if (afterBuild) return "notice";
  return building ? "follow" : "build";
};

/**
 * The viewer asks again, once the PDF a Build made is on screen, for the line
 * of a Jump made while that Build ran. Not while another Build is on its way
 * (that PDF is about to go), and not after the automatic Jump that followed
 * the Build (it would be a second move).
 */
export const recheckAllowed = ({ preparingBuild, building, autoJumped }: {
  preparingBuild: boolean;
  building: boolean;
  autoJumped: boolean;
}) => !preparingBuild && !building && !autoJumped;

/** The text that line is a line of: the one it had when the Jump was made, else the editor's now. */
export const recheckText = ({ jump, file, line, current }: {
  jump: { path: string; line: number; text: string } | null;
  file: string;
  line: number;
  current: string | undefined;
}) => (jump && jump.path === file && jump.line === line ? jump.text : current);
