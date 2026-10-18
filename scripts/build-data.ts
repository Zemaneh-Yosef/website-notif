// Run by update.sh on the vendored site: _data/zmanim.yml → zmanim.json, so the service itself needs no
// YAML parser (and no package at all) at run time.
import { parse } from "@std/yaml";

const dir = Deno.args[0];
const data = parse(await Deno.readTextFile(`${dir}/_data/zmanim.yml`));
if (!Array.isArray(data) || !data.length) throw new Error("zmanim.yml: expected a list of zemanim");
await Deno.writeTextFile(`${dir}/zmanim.json`, JSON.stringify(data));
console.log(`zmanim.json: ${data.length} zemanim`);
