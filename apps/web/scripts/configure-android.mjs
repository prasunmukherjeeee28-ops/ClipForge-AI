import { readFile, writeFile } from "node:fs/promises";

const manifestPath = "android/app/src/main/AndroidManifest.xml";
let manifest = await readFile(manifestPath, "utf8");

if (!manifest.includes('android:host="auth"')) {
  const activityMarker = 'android:name=".MainActivity"';
  const markerIndex = manifest.indexOf(activityMarker);
  if (markerIndex < 0) {
    throw new Error("Could not find the generated Capacitor MainActivity in AndroidManifest.xml.");
  }

  const activityEnd = manifest.indexOf("</activity>", markerIndex);
  if (activityEnd < 0) {
    throw new Error("Could not locate the MainActivity manifest block.");
  }

  const intentFilter = \`
            <intent-filter>
                <action android:name="android.intent.action.VIEW" />
                <category android:name="android.intent.category.DEFAULT" />
                <category android:name="android.intent.category.BROWSABLE" />
                <data android:scheme="com.clipforge.app" android:host="auth" />
            </intent-filter>
\`;
  manifest = manifest.slice(0, activityEnd) + intentFilter + manifest.slice(activityEnd);
  await writeFile(manifestPath, manifest);
}
console.log("Registered com.clipforge.app://auth deep link.");
