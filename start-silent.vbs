' Serrano30 — Silent Launcher
' Double-click this file to start Serrano30 without showing a terminal window.
' The server runs in the background. Close it from Task Manager if needed.

Set WshShell = CreateObject("WScript.Shell")
WshShell.CurrentDirectory = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
WshShell.Run "start.bat", 0, False
