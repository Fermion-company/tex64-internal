// Side-effect imports: ensure math-wysiwyg core and trigger packs are bundled for Blocks math input.
import "../../math/wysiwyg/math-wysiwyg.js";
import "../../math/wysiwyg/math-wysiwyg-packs.js";

export type { BlockInputApi } from "./input-ui/types.js";

export { initBlockInputUi } from "./input-ui/init.js";
