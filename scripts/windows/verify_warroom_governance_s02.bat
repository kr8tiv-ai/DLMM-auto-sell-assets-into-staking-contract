@echo off
setlocal

set "FRONTEND_DIR=C:\Users\lucid\Desktop\Brain Website Build"
set "ROOT_DIR=C:\Users\lucid\desktop\brain staking"

if not exist "%FRONTEND_DIR%\package.json" (
  echo [verify] Frontend repo not found at: %FRONTEND_DIR%
  exit /b 1
)

echo [verify] Running governance tab checks in "%FRONTEND_DIR%"

pushd "%FRONTEND_DIR%"
if errorlevel 1 (
  echo [verify] Failed to enter frontend directory
  exit /b 1
)

echo [verify] 1/4 Typecheck
call npx --no-install tsc --noEmit --target ES2020
if errorlevel 1 (
  echo [verify] Typecheck failed
  popd
  exit /b 1
)

echo [verify] 2/4 Governance UI tests
call npx --no-install vitest run tests/governance/governance-tab.test.tsx tests/governance/exits-provenance.test.tsx
if errorlevel 1 (
  echo [verify] Governance tests failed
  popd
  exit /b 1
)

echo [verify] 3/4 Governance integration regressions
call npx --no-install --prefix "%ROOT_DIR%" ts-mocha -p "%ROOT_DIR%\tsconfig.json" -t 1000000 "%ROOT_DIR%\tests\governance.ts" --grep "governance_initiate_exit|close_proposal"
if errorlevel 1 (
  echo [verify] Governance integration regression failed
  popd
  exit /b 1
)

echo [verify] 4/4 Next build
call npx --no-install next build
if errorlevel 1 (
  echo [verify] Next build failed
  popd
  exit /b 1
)

popd
echo [verify] Governance verification passed
exit /b 0
