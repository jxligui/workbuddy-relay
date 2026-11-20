# 恢复深信服 Promote 服务（已备份的原始状态）
# 原状态: StartMode=Manual State=Running
Set-Service -Name SangforSP -StartupType Manual
Start-Service -Name SangforSP -ErrorAction SilentlyContinue
Get-Service SangforSP | Select-Object Name, Status, StartType
