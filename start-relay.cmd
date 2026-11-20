@echo off
rem Start the WorkBuddy relay hidden, once (skips when the port already answers).
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$h = Invoke-RestMethod -Uri 'http://127.0.0.1:41142/healthz' -TimeoutSec 2 -ErrorAction SilentlyContinue; if ($h -and $h.ok) { exit 0 }; Start-Process -FilePath 'node' -ArgumentList 'server.mjs' -WorkingDirectory '%~dp0' -WindowStyle Hidden"
