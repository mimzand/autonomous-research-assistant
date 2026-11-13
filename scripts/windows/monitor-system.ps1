<#
.SYNOPSIS
  Read-only, low-frequency system monitor for diagnosing hard freezes (ADK migration phase 7.2).

.DESCRIPTION
  Appends one CSV line every -IntervalSeconds (default 10, minimum 5) with:
    - GPU (via nvidia-smi, if installed): utilization %, memory used/total MiB,
      temperature C, power draw W, SM clock MHz, performance state;
    - available system RAM (MB) and total CPU utilization (%) from Windows
      performance counters;
    - working set (MB) of Ollama and Node processes.
  CPU temperature is NOT recorded: Windows exposes no reliable CPU package
  temperature without vendor tools (MSAcpi_ThermalZoneTemperature reports ACPI
  zones, not the CPU, and is often static or missing).

  It only reads values. It never changes power, clock, fan, driver, registry or
  Ollama settings, and it does not start or stop any workload. Each line is
  written with write-through so that lines written before a freeze are likely
  to survive a forced power-off (not guaranteed).

  Stop it with Ctrl+C. It also stops after -DurationMinutes.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\windows\monitor-system.ps1 -OutFile "$env:USERPROFILE\Desktop\rka-monitor.csv"
#>
param(
  [ValidateRange(5, 3600)][int]$IntervalSeconds = 10,
  [ValidateRange(1, 1440)][int]$DurationMinutes = 60,
  [string]$OutFile = (Join-Path $env:USERPROFILE 'Desktop\rka-monitor.csv')
)

$ErrorActionPreference = 'Stop'
$nvidiaSmi = Get-Command nvidia-smi -ErrorAction SilentlyContinue
$gpuFields = 'utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw,clocks.sm,pstate'

function Write-Line([string]$path, [string]$line) {
  $stream = New-Object System.IO.FileStream($path, [System.IO.FileMode]::Append, [System.IO.FileAccess]::Write,
    [System.IO.FileShare]::Read, 4096, [System.IO.FileOptions]::WriteThrough)
  try {
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($line + "`r`n")
    $stream.Write($bytes, 0, $bytes.Length)
    $stream.Flush($true)
  } finally {
    $stream.Dispose()
  }
}

if (-not (Test-Path $OutFile)) {
  Write-Line $OutFile 'timestamp,gpu_util_pct,gpu_mem_used_mib,gpu_mem_total_mib,gpu_temp_c,gpu_power_w,gpu_sm_clock_mhz,gpu_pstate,ram_available_mb,cpu_total_pct,ollama_ws_mb,node_ws_mb'
}
Write-Host "Monitoring every $IntervalSeconds s for up to $DurationMinutes min -> $OutFile (Ctrl+C to stop)"
if (-not $nvidiaSmi) { Write-Host 'nvidia-smi not found: GPU columns stay empty.' }

$deadline = (Get-Date).AddMinutes($DurationMinutes)
while ((Get-Date) -lt $deadline) {
  $gpu = ',,,,,,'
  if ($nvidiaSmi) {
    try {
      $raw = & $nvidiaSmi.Source "--query-gpu=$gpuFields" '--format=csv,noheader,nounits' 2>$null | Select-Object -First 1
      if ($raw) { $gpu = ($raw -split ',\s*' | ForEach-Object { $_.Trim() }) -join ',' }
    } catch { $gpu = ',,,,,,' }
  }
  $ram = ''; $cpu = ''
  try {
    $samples = (Get-Counter -Counter '\Memory\Available MBytes', '\Processor(_Total)\% Processor Time' -MaxSamples 1).CounterSamples
    $ram = [math]::Round(($samples | Where-Object Path -like '*available mbytes').CookedValue)
    $cpu = [math]::Round(($samples | Where-Object Path -like '*processor time').CookedValue, 1)
  } catch { }
  $ws = {
    param($name)
    $p = Get-Process -Name $name -ErrorAction SilentlyContinue
    if ($p) { [math]::Round((($p | Measure-Object WorkingSet64 -Sum).Sum) / 1MB) } else { '' }
  }
  $line = '{0},{1},{2},{3},{4},{5}' -f (Get-Date).ToString('o'), $gpu, $ram, $cpu, (& $ws 'ollama*'), (& $ws 'node')
  Write-Line $OutFile $line
  Start-Sleep -Seconds $IntervalSeconds
}
Write-Host 'Monitoring finished.'
