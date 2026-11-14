# Android APK

ClipForge Android APKs are built by the GitHub Actions workflow at `.github/workflows/android-apk.yml` using Capacitor and the existing React web application.

To build manually, open Actions → Build ClipForge Android APK → Run workflow. The workflow uploads `ClipForge-APK` as an artifact containing `app-debug.apk`.

The APK packages the existing frontend. API and video-processing services remain hosted separately; the APK does not embed backend secrets or run the Python processor on the phone.
