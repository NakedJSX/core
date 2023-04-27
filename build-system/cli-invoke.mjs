import { main } from "./cli.mjs";

//
// The standalone npx nakedjsx command relies on being able
// to import main and selectively invoke it. It's simplest
// to use an explict invoke wrapper with npx and friends.
//

await main();
