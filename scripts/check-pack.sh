#!/bin/sh
set -eu

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

bun pm pack --filename "$work/package.tgz" --quiet
mkdir "$work/app"
cd "$work/app"
echo '{ "name": "pack-check", "private": true, "type": "module" }' > package.json
bun add "$work/package.tgz"

cd node_modules/@distube/ytdl-core
node --input-type=module -e '
const { Ytdl } = await import("@distube/ytdl-core");
const { SabrStream } = await import("googlevideo/sabr-stream");
if (typeof Ytdl !== "function" || typeof SabrStream !== "function") throw new Error("the packed package cannot load SABR");
console.log("packed package loads SABR from its googlevideo dependency");
'
