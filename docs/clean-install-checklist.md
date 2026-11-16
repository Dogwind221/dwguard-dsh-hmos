# Clean install checklist (1.0.0)

Goal: prove a developer with a clean DSH profile can install and load the
published package, not just the developer's long-lived profile.

## A. From the npm release (after 0.9.9/1.0.0 is published)

Use a **temporary profile**, never the live `desktop` profile:

```powershell
$profile = "dwguard-clean-$PID"
dsh --profile $profile --from-default-profile headless --dump-config
dsh plugin --profile $profile add dwguard-dsh-hmos@<version>
dsh --profile $profile --dump-config | Select-String dwguard-hmos
```

Expected host row:

```text
# == dwguard-dsh-hmos
- id: dwguard-hmos
  name: dwguard-dsh-hmos
```

Then boot once (needs the user's model credential):

```powershell
dsh --profile $profile headless "只回复 CLEAN-INSTALL-OK，不要调用任何工具。"
```

Expected: `CLEAN-INSTALL-OK`, exit code 0. Remove the temp profile after:

```powershell
Remove-Item "$env:USERPROFILE\.dsh\profiles\$profile" -Recurse -Force
```

## B. From a local tarball (pre-publish rehearsal)

```powershell
npm pack
$profile = "dwguard-tarball-$PID"
dsh --profile $profile --from-default-profile headless --dump-config
dsh plugin --profile $profile add "file:F:/dsh/Github/dwguard-dsh-hmos/dwguard-dsh-hmos-<version>.tgz"
dsh --profile $profile --dump-config | Select-String dwguard-hmos
```

## C. What this does **not** prove

- It does not test the live `desktop` profile upgrade path.
- It does not prove physical-device coverage.
- It does not prove market listing/catalog refresh.
- It does not test uninstall/reinstall of the desktop app.

Record the actual commands, version, output and date in the release evidence.
