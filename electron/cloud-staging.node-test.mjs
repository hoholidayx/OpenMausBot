import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { CLOUD_ORIGIN, STAGING_CLOUD_ORIGIN, cloudOrigin, cloudTarget } from "./cloud-account.mjs";


test("OMB_CLOUD_STAGING=1, and only that, points the app at the fixed staging Admin with its own token file", () => {
  assert.deepEqual(cloudTarget({}), { origin: CLOUD_ORIGIN, staging: false, file: "cloud-account.bin", saved: "cloud-accounts.bin", places: "account-places.json", environments: "environments.json", sync: "cloud-sync", look: "cloud-home-look.json" });
  assert.deepEqual(cloudTarget({ OMB_CLOUD_STAGING: "1" }), { origin: "https://omb-cloud-staging.fly.dev", staging: true, file: "cloud-account-staging.bin", saved: "cloud-accounts-staging.bin", places: "account-places-staging.json",
    environments: "environments-staging.json", sync: "cloud-sync-staging", look: "cloud-home-look-staging.json" });
  const production = Object.values(cloudTarget({})), staging = Object.values(cloudTarget({ OMB_CLOUD_STAGING: "1" }));
  assert.ok(staging.filter(value => typeof value === "string").every(name => !production.includes(name)), "no file or address shared with production");
  assert.equal(STAGING_CLOUD_ORIGIN, "https://omb-cloud-staging.fly.dev");
  for (const value of ["0", "true", "yes", " 1", "1 ", "01", "2", "", "https://evil.example.test", "https://omb-cloud-staging.fly.dev"]) {
    assert.deepEqual(cloudTarget({ OMB_CLOUD_STAGING: value }), cloudTarget({}), JSON.stringify(value));
  }
  assert.deepEqual(cloudTarget({ OMB_CLOUD_ORIGIN: "https://evil.example.test", OMB_CLOUD_STAGING_URL: "https://evil.example.test" }), cloudTarget({}), "no address is ever read from the environment");
  assert.deepEqual(cloudTarget(undefined).origin, process.env.OMB_CLOUD_STAGING === "1" ? STAGING_CLOUD_ORIGIN : CLOUD_ORIGIN);
});

test("the staging address is the one exact https origin", () => {
  assert.equal(cloudOrigin(STAGING_CLOUD_ORIGIN), STAGING_CLOUD_ORIGIN);
  for (const value of ["http://omb-cloud-staging.fly.dev", `${STAGING_CLOUD_ORIGIN}/`, `${STAGING_CLOUD_ORIGIN}:8443`, "https://omb-cloud-staging.fly.dev.evil.test", "https://evil.fly.dev"]) {
    assert.throws(() => cloudOrigin(value), /Invalid MausBot Cloud address/, value);
  }

});


test("main keeps each Admin's sign-in, saved servers, Files state and Cloud name in their own files, and gives the client the chosen Admin", () => {
  const main = readFileSync(new URL("./main.mjs", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  assert.match(main, /function environmentsFile\(\) \{\n  return path\.join\(app\.getPath\("userData"\), cloudTarget\(process\.env\)\.environments\);/);
  assert.match(main, /stateDir: cloudTarget\(process\.env\)\.sync,/);
  assert.match(main, /lookFile\(\(\) => path\.join\(app\.getPath\("userData"\), cloudTarget\(process\.env\)\.look\), fs\)/);
  for (const name of ['"environments.json"', '"cloud-home-look.json"']) assert.equal(main.includes(name), false, `no fixed ${name}`);
  const ensure = main.slice(main.indexOf("function ensureCloudAccount() {"), main.indexOf("\n}\n", main.indexOf("function ensureCloudAccount() {")));
  assert.match(ensure, /store: cloudAccountStore\(\),/);
  assert.match(main, /const cloudAccountStore = \(\) => \(activeSignIn \?\?= createCloudAccountStore\(\{ file: path\.join\(app\.getPath\("userData"\), cloudTarget\(process\.env\)\.file\)/);
  assert.match(main, /createCloudAccountStore\(\{ file: path\.join\(app\.getPath\("userData"\), cloudTarget\(process\.env\)\.saved\)/);
  assert.match(ensure, /origin: cloudTarget\(process\.env\)\.origin,/);
  assert.equal(main.includes('"cloud-account.bin"'), false, "no second, fixed token file");
});
