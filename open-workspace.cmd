@echo off
setlocal
set "PROJECT_DIR=%~dp0"
code --user-data-dir "%PROJECT_DIR%.vscode\user-data" --extensions-dir "%PROJECT_DIR%.vscode\extensions" "%PROJECT_DIR%StarBrowser3.code-workspace"
