' vision-proxy.vbs  -  start the vision proxy at Windows logon, no console window.
'
' Install: press Win+R, type  shell:startup , Enter, and drop a shortcut to this
' file (or this file itself) into the folder that opens. It runs at every logon.
'
' Edit the two paths below for your box:
'   - PYTHON  : your python.exe (or just "python" if it is on PATH)
'   - PROXY   : full path to shim/vision_shim.py from this repo
'
' The "0" argument runs it hidden; "False" means do not wait.

PYTHON = "python"
PROXY  = "C:\path\to\DeepSeek-Harness-Vision-Tools\shim\vision_shim.py"
ARGS   = " --host 127.0.0.1 --port 8900"

Set sh = CreateObject("WScript.Shell")
sh.Run """" & PYTHON & """ """ & PROXY & """" & ARGS, 0, False
