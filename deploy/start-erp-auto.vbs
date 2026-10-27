' ERP backend hidden auto-start: launches deploy\start-erp-auto.bat with no console window
Dim sh, base
base = "D:\wk\2026-10-26-09-45-32\erp-mindmap\deploy"
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = base
sh.Run "cmd /c " & Chr(34) & base & "\start-erp-auto.bat" & Chr(34), 0, False
