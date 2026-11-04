# env-check.ps1 - READ-ONLY environment inspection for Autonomous Research & Knowledge Assistant
# Installs nothing, changes nothing, prints no environment variables or secrets.
# Writes results to env-report.txt next to this script.
# Run:  powershell -ExecutionPolicy Bypass -File .\env-check.ps1

$ErrorActionPreference = 'Continue'
$Report = Join-Path $PSScriptRoot 'env-report.txt'
# Ollama base URL. Default uses 127.0.0.1, not 'localhost': on Windows 'localhost' can resolve to IPv6 ::1,
# where Ollama is not listening by default. Override with $env:OLLAMA_HOST (same var the Ollama CLI uses,
# e.g. '127.0.0.1:11434', 'http://127.0.0.1:11434'). A 0.0.0.0 bind address is probed via 127.0.0.1.
$DefaultOllamaBase = 'http://127.0.0.1:11434'
function Resolve-OllamaBase([string]$hostVar) {
  if ([string]::IsNullOrWhiteSpace($hostVar)) { return $DefaultOllamaBase }
  $h = $hostVar.Trim().TrimEnd('/')
  if ($h -notmatch '^[a-zA-Z][a-zA-Z0-9+.-]*://') { $h = 'http://' + $h }
  try { $u = [Uri]$h } catch { return $DefaultOllamaBase }
  $hostName = $u.Host
  if ($hostName -eq '0.0.0.0' -or $hostName -eq '[::]' -or $hostName -eq '::') { $hostName = '127.0.0.1' }
  $port = 11434
  if ($hostVar -match ':\d+/?$' -or -not $u.IsDefaultPort) { $port = $u.Port }
  return ($u.Scheme + '://' + $hostName + ':' + $port)
}
$Base = Resolve-OllamaBase $env:OLLAMA_HOST
$Model = 'qwen3:8b'
$lines = New-Object System.Collections.Generic.List[string]
function Add([string]$s) { $lines.Add($s); Write-Host $s }
function Section([string]$t) { Add ''; Add ('=== ' + $t + ' ===') }
function Try-Cmd([string]$label, [scriptblock]$sb) {
  try { $r = (& $sb 2>&1 | Out-String).Trim(); if (-not $r) { $r = '(no output)' }; Add ($label + ': ' + $r) }
  catch { Add ($label + ': ERROR ' + $_.Exception.Message) }
}
function Post-Json([string]$path, $body, [int]$timeout = 300) {
  $json = $body | ConvertTo-Json -Depth 20 -Compress
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $r = Invoke-RestMethod -Uri ($Base + $path) -Method Post -ContentType 'application/json' -Body ([Text.Encoding]::UTF8.GetBytes($json)) -TimeoutSec $timeout
  $sw.Stop()
  return @{ r = $r; ms = $sw.ElapsedMilliseconds }
}

Section 'System'
Add ('Timestamp: ' + (Get-Date -Format o))
Try-Cmd 'OS' { (Get-CimInstance Win32_OperatingSystem | ForEach-Object { $_.Caption + ' ' + $_.Version + ' (' + $_.OSArchitecture + ')' }) }
Try-Cmd 'CPU' { (Get-CimInstance Win32_Processor | Select-Object -First 1).Name }
Try-Cmd 'RAM (GB)' { [math]::Round((Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory / 1GB, 1) }
Try-Cmd 'PowerShell' { $PSVersionTable.PSVersion.ToString() }

Section '1. Toolchain'
foreach ($c in 'node','npm','pnpm','git') {
  $cmd = Get-Command $c -ErrorAction SilentlyContinue
  if ($cmd) { Try-Cmd ($c + ' (' + $cmd.Source + ')') { & $c --version } } else { Add ($c + ': NOT FOUND on PATH') }
}

Section '2. Ollama install / process'
$oc = Get-Command ollama -ErrorAction SilentlyContinue
if ($oc) { Add ('ollama CLI: ' + $oc.Source); Try-Cmd 'ollama --version' { ollama --version } } else { Add 'ollama CLI: NOT FOUND on PATH' }
$procs = Get-Process -Name 'ollama*' -ErrorAction SilentlyContinue
if ($procs) { Add ('Processes: ' + (($procs | ForEach-Object { $_.ProcessName + '#' + $_.Id }) -join ', ')) } else { Add 'Processes: none running' }

Section '5. Ollama API'
$apiUp = $false
$src = 'default'; if ($env:OLLAMA_HOST) { $src = 'OLLAMA_HOST' }
Add ('Base URL: ' + $Base + ' (' + $src + ')')
try { $v = Invoke-RestMethod -Uri ($Base + '/api/version') -TimeoutSec 5; Add ('GET /api/version: OK ' + ($v | ConvertTo-Json -Compress)); $apiUp = $true }
catch { Add ('GET /api/version: FAILED ' + $_.Exception.Message) }

Section '3/4. Models'
$hasModel = $false
if ($apiUp) {
  try {
    $tags = Invoke-RestMethod -Uri ($Base + '/api/tags') -TimeoutSec 10
    if (-not $tags.models) { Add 'Installed models: (none)' }
    foreach ($m in $tags.models) {
      Add ('- ' + $m.name + ' | ' + [math]::Round($m.size / 1GB, 2) + ' GB | ' + $m.details.parameter_size + ' | ' + $m.details.quantization_level + ' | family=' + $m.details.family)
      if ($m.name -eq $Model -or $m.name -eq ($Model + ':latest')) { $hasModel = $true }
    }
  } catch { Add ('GET /api/tags: FAILED ' + $_.Exception.Message) }
} elseif ($oc) { Try-Cmd 'ollama list' { ollama list } }
Add ($Model + ' installed: ' + $hasModel)
if ($hasModel) {
  try {
    $s = Post-Json '/api/show' @{ model = $Model } 30
    Add ('capabilities: ' + (($s.r.capabilities) -join ', '))
    $ctx = $null
    if ($s.r.model_info) { $s.r.model_info.PSObject.Properties | Where-Object { $_.Name -like '*context_length' } | ForEach-Object { $ctx = $_.Value } }
    Add ('native context_length: ' + $ctx)
    Add ('parameter_size / quant: ' + $s.r.details.parameter_size + ' / ' + $s.r.details.quantization_level)
  } catch { Add ('POST /api/show: FAILED ' + $_.Exception.Message) }
}

Section '6. GPU'
$smi = Get-Command nvidia-smi -ErrorAction SilentlyContinue
if ($smi) {
  Try-Cmd 'nvidia-smi query' { nvidia-smi --query-gpu=name,memory.total,memory.used,memory.free,driver_version,compute_cap --format=csv }
  Try-Cmd 'nvidia-smi header' { (nvidia-smi | Select-Object -First 4) -join "`n" }
} else { Add 'nvidia-smi: NOT FOUND on PATH' }
Try-Cmd 'All video controllers (WMI; VRAM here is unreliable >4GB)' { Get-CimInstance Win32_VideoController | ForEach-Object { $_.Name + ' | driver ' + $_.DriverVersion } }

if ($apiUp -and $hasModel) {
  Section '7. Minimal generation test'
  try {
    $g = Post-Json '/api/chat' @{ model = $Model; stream = $false; think = $false; options = @{ num_ctx = 4096; temperature = 0 }; messages = @(@{ role = 'user'; content = 'Reply with exactly: READY' }) }
    Add ('reply: ' + $g.r.message.content.Trim())
    Add ('wall ms: ' + $g.ms + ' | load ms: ' + [math]::Round($g.r.load_duration / 1e6) + ' | eval tokens: ' + $g.r.eval_count + ' | tok/s: ' + [math]::Round($g.r.eval_count / ($g.r.eval_duration / 1e9), 1))
  } catch { Add ('generation: FAILED ' + $_.Exception.Message) }

  Section 'GPU offload (GET /api/ps while model loaded)'
  try {
    $ps = Invoke-RestMethod -Uri ($Base + '/api/ps') -TimeoutSec 10
    foreach ($m in $ps.models) {
      $pct = 0; if ($m.size -gt 0) { $pct = [math]::Round(100 * $m.size_vram / $m.size) }
      Add ('- ' + $m.name + ' | total ' + [math]::Round($m.size / 1GB, 2) + ' GB | in VRAM ' + [math]::Round($m.size_vram / 1GB, 2) + ' GB (' + $pct + '% GPU) | ctx ' + $m.context_length)
    }
  } catch { Add ('GET /api/ps: FAILED ' + $_.Exception.Message) }
  if ($smi) { Try-Cmd 'nvidia-smi memory while loaded' { nvidia-smi --query-gpu=memory.used,memory.total --format=csv,noheader } }

  Section 'Tool-calling test (native /api/chat tools)'
  try {
    $tool = @{ type = 'function'; function = @{ name = 'web_search'; description = 'Search the web'; parameters = @{ type = 'object'; properties = @{ query = @{ type = 'string' } }; required = @('query') } } }
    $t = Post-Json '/api/chat' @{ model = $Model; stream = $false; think = $false; options = @{ num_ctx = 4096; temperature = 0 }; tools = @($tool); messages = @(@{ role = 'user'; content = 'Find recent news about solid-state batteries. Use the tool.' }) }
    if ($t.r.message.tool_calls) { Add ('tool_calls: ' + ($t.r.message.tool_calls | ConvertTo-Json -Depth 10 -Compress)) } else { Add ('NO tool_calls. content: ' + $t.r.message.content) }
    Add ('wall ms: ' + $t.ms)
  } catch { Add ('tool test: FAILED ' + $_.Exception.Message) }

  Section 'Structured output test (format = JSON schema)'
  try {
    $schema = @{ type = 'object'; properties = @{ topic = @{ type = 'string' }; subquestions = @{ type = 'array'; items = @{ type = 'string' } } }; required = @('topic','subquestions') }
    $o = Post-Json '/api/chat' @{ model = $Model; stream = $false; think = $false; format = $schema; options = @{ num_ctx = 4096; temperature = 0 }; messages = @(@{ role = 'user'; content = 'Plan research on home heat pumps: give the topic and 3 subquestions.' }) }
    Add ('raw: ' + $o.r.message.content)
    try { $null = $o.r.message.content | ConvertFrom-Json; Add 'parses as JSON: True' } catch { Add 'parses as JSON: False' }
    Add ('wall ms: ' + $o.ms)
  } catch { Add ('structured test: FAILED ' + $_.Exception.Message) }

  Section 'OpenAI-compatible endpoint (/v1) reachability'
  try { $v1 = Invoke-RestMethod -Uri ($Base + '/v1/models') -TimeoutSec 10; Add ('/v1/models: OK, ' + @($v1.data).Count + ' models') } catch { Add ('/v1/models: FAILED ' + $_.Exception.Message) }
}

$lines | Out-File -FilePath $Report -Encoding utf8
Write-Host ''
Write-Host ('Report written to ' + $Report)
