param([ValidateSet('up', 'down')][string]$Action = 'up')

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$envFile = Join-Path $root '.env'
$psql = 'D:\Program Files\PostgreSQL\17\bin\psql.exe'

if ($Action -eq 'down') {
  Write-Output 'PostgreSQL on port 5432 is shared; this command does not stop it.'
  exit 0
}
if (-not (Test-Path -LiteralPath $psql)) { throw "PostgreSQL client is missing: $psql" }
if (-not (Test-Path -LiteralPath $envFile)) { throw 'Run npm run setup first.' }

$content = [IO.File]::ReadAllText($envFile)
$urlMatch = [regex]::Match($content, '(?m)^DATABASE_URL=(.+)$')
if (-not $urlMatch.Success) { throw 'DATABASE_URL is missing from .env.' }
$uri = [Uri]$urlMatch.Groups[1].Value.Trim()
if ($uri.Scheme -ne 'postgresql' -or $uri.Host -ne '127.0.0.1' -or
    $uri.Port -ne 5432 -or $uri.AbsolutePath -ne '/saas_framework' -or
    $uri.UserInfo.Split(':', 2)[0] -ne 'saas_framework') {
  throw 'DATABASE_URL must point to saas_framework on 127.0.0.1:5432.'
}

$role = (& $psql -h 127.0.0.1 -p 5432 -U postgres -d postgres -X -A -t -w `
  -v ON_ERROR_STOP=1 -c "SELECT 1 FROM pg_roles WHERE rolname='saas_framework'" | Out-String).Trim()
if ($LASTEXITCODE -ne 0) { throw 'Could not connect to the local PostgreSQL administrator on port 5432.' }
$owner = (& $psql -h 127.0.0.1 -p 5432 -U postgres -d postgres -X -A -t -w `
  -v ON_ERROR_STOP=1 -c "SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname='saas_framework'" | Out-String).Trim()
if ($LASTEXITCODE -ne 0) { throw 'Could not inspect the SaaS database.' }
if ($owner -ne '' -and $owner -ne 'saas_framework') {
  throw 'The existing saas_framework database belongs to another role; inspect it before continuing.'
}

if ($role -eq '') {
  $password = [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(24)).ToLowerInvariant()
  "CREATE ROLE saas_framework LOGIN PASSWORD '$password';" | & $psql -h 127.0.0.1 -p 5432 `
    -U postgres -d postgres -X -w -v ON_ERROR_STOP=1 -f -
  if ($LASTEXITCODE -ne 0) { throw 'Could not create the dedicated SaaS role.' }
  $newUrl = "postgresql://saas_framework:${password}@127.0.0.1:5432/saas_framework"
  $content = $content.Replace($urlMatch.Value, "DATABASE_URL=$newUrl")
  [IO.File]::WriteAllText($envFile, $content)
} else {
  $password = [Uri]::UnescapeDataString($uri.UserInfo.Split(':', 2)[1])
}

if ($owner -eq '') {
  'CREATE DATABASE saas_framework OWNER saas_framework;' | & $psql -h 127.0.0.1 -p 5432 `
    -U postgres -d postgres -X -w -v ON_ERROR_STOP=1 -f -
  if ($LASTEXITCODE -ne 0) { throw 'Could not create the dedicated SaaS database.' }
}

$env:PGPASSWORD = $password
try {
  & $psql -h 127.0.0.1 -p 5432 -U saas_framework -d saas_framework -X -A -t -w `
    -v ON_ERROR_STOP=1 -c 'SELECT 1' | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'The SaaS database credentials in .env are invalid.' }
} finally {
  Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue
}
Write-Output 'SaaS PostgreSQL is ready on 127.0.0.1:5432/saas_framework.'
