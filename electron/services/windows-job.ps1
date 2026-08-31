param(
  [Parameter(Mandatory = $true)]
  [string]$ConfigPath
)

$ErrorActionPreference = "Stop"

function Write-JobStatus {
  param(
    [Parameter(Mandatory = $true)] [string]$Path,
    [Parameter(Mandatory = $true)] [System.Collections.IDictionary]$Value
  )
  $temporaryPath = "$Path.tmp"
  $json = $Value | ConvertTo-Json -Compress
  $utf8NoBom = New-Object System.Text.UTF8Encoding -ArgumentList $false
  [System.IO.File]::WriteAllText(
    $temporaryPath,
    $json,
    $utf8NoBom
  )
  Move-Item -LiteralPath $temporaryPath -Destination $Path -Force
}

$config = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
Remove-Item -LiteralPath $ConfigPath -Force -ErrorAction SilentlyContinue

$source = @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public sealed class Tex64JobResult
{
    public int TargetExitCode;
    public bool CleanupOk;
    public bool Cancelled;
}

public static class Tex64JobRunner
{
    private const uint CREATE_SUSPENDED = 0x00000004;
    private const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;
    private const uint EXTENDED_STARTUPINFO_PRESENT = 0x00080000;
    private const uint STARTF_USESTDHANDLES = 0x00000100;
    private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
    private const int JobObjectBasicAccountingInformation = 1;
    private const int JobObjectExtendedLimitInformation = 9;
    private const long PROC_THREAD_ATTRIBUTE_JOB_LIST = 0x0002000D;
    private const long PROC_THREAD_ATTRIBUTE_HANDLE_LIST = 0x00020002;
    private const uint HANDLE_FLAG_INHERIT = 0x00000001;
    private const uint WAIT_OBJECT_0 = 0;
    private const uint WAIT_TIMEOUT = 258;
    private const uint WAIT_FAILED = 0xFFFFFFFF;
    private const uint SYNCHRONIZE = 0x00100000;
    private const int STD_INPUT_HANDLE = -10;
    private const int STD_OUTPUT_HANDLE = -11;
    private const int STD_ERROR_HANDLE = -12;

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public long Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IO_COUNTERS
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_ACCOUNTING_INFORMATION
    {
        public long TotalUserTime;
        public long TotalKernelTime;
        public long ThisPeriodTotalUserTime;
        public long ThisPeriodTotalKernelTime;
        public uint TotalPageFaultCount;
        public uint TotalProcesses;
        public uint ActiveProcesses;
        public uint TotalTerminatedProcesses;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct STARTUPINFO
    {
        public int cb;
        public string lpReserved;
        public string lpDesktop;
        public string lpTitle;
        public int dwX;
        public int dwY;
        public int dwXSize;
        public int dwYSize;
        public int dwXCountChars;
        public int dwYCountChars;
        public int dwFillAttribute;
        public uint dwFlags;
        public short wShowWindow;
        public short cbReserved2;
        public IntPtr lpReserved2;
        public IntPtr hStdInput;
        public IntPtr hStdOutput;
        public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct STARTUPINFOEX
    {
        public STARTUPINFO StartupInfo;
        public IntPtr lpAttributeList;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PROCESS_INFORMATION
    {
        public IntPtr hProcess;
        public IntPtr hThread;
        public uint dwProcessId;
        public uint dwThreadId;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateJobObject(IntPtr attributes, string name);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(
        IntPtr job,
        int informationClass,
        IntPtr information,
        uint informationLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool QueryInformationJobObject(
        IntPtr job,
        int informationClass,
        out JOBOBJECT_BASIC_ACCOUNTING_INFORMATION information,
        uint informationLength,
        IntPtr returnLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateJobObject(IntPtr job, uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool InitializeProcThreadAttributeList(
        IntPtr attributeList,
        int attributeCount,
        int flags,
        ref IntPtr size);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool UpdateProcThreadAttribute(
        IntPtr attributeList,
        uint flags,
        IntPtr attribute,
        IntPtr value,
        IntPtr size,
        IntPtr previousValue,
        IntPtr returnSize);

    [DllImport("kernel32.dll")]
    private static extern void DeleteProcThreadAttributeList(IntPtr attributeList);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CreateProcess(
        string applicationName,
        StringBuilder commandLine,
        IntPtr processAttributes,
        IntPtr threadAttributes,
        bool inheritHandles,
        uint creationFlags,
        IntPtr environment,
        string currentDirectory,
        ref STARTUPINFOEX startupInfo,
        out PROCESS_INFORMATION processInformation);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint ResumeThread(IntPtr thread);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr GetStdHandle(int standardHandle);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetHandleInformation(
        IntPtr handle,
        uint mask,
        uint flags);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(
        uint desiredAccess,
        bool inheritHandle,
        uint processId);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    private static void ThrowLastError(string operation)
    {
        throw new Win32Exception(Marshal.GetLastWin32Error(), operation);
    }

    private static uint ActiveProcesses(IntPtr job)
    {
        JOBOBJECT_BASIC_ACCOUNTING_INFORMATION info;
        if (!QueryInformationJobObject(
            job,
            JobObjectBasicAccountingInformation,
            out info,
            (uint)Marshal.SizeOf(typeof(JOBOBJECT_BASIC_ACCOUNTING_INFORMATION)),
            IntPtr.Zero))
        {
            ThrowLastError("QueryInformationJobObject");
        }
        return info.ActiveProcesses;
    }

    private static bool StopAndDrainJob(IntPtr job, int timeoutMs)
    {
        try
        {
            if (ActiveProcesses(job) > 0 && !TerminateJobObject(job, 1))
            {
                return false;
            }
            System.Diagnostics.Stopwatch timer = System.Diagnostics.Stopwatch.StartNew();
            while (ActiveProcesses(job) > 0)
            {
                if (timer.ElapsedMilliseconds >= Math.Max(250, timeoutMs)) return false;
                Thread.Sleep(25);
            }
            return true;
        }
        catch
        {
            return false;
        }
    }

    public static Tex64JobResult Run(
        string executable,
        string commandLine,
        string workingDirectory,
        string cancelPath,
        int parentPid,
        int cleanupTimeoutMs)
    {
        IntPtr job = IntPtr.Zero;
        IntPtr limitInfoPointer = IntPtr.Zero;
        IntPtr attributeList = IntPtr.Zero;
        IntPtr jobValue = IntPtr.Zero;
        IntPtr handleList = IntPtr.Zero;
        IntPtr parentProcess = IntPtr.Zero;
        PROCESS_INFORMATION process = new PROCESS_INFORMATION();
        bool attributeListInitialized = false;
        try
        {
            parentProcess = OpenProcess(SYNCHRONIZE, false, unchecked((uint)parentPid));
            if (parentProcess == IntPtr.Zero) ThrowLastError("OpenProcess(parent)");
            job = CreateJobObject(IntPtr.Zero, null);
            if (job == IntPtr.Zero) ThrowLastError("CreateJobObject");

            JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits =
                new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            int limitsSize = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
            limitInfoPointer = Marshal.AllocHGlobal(limitsSize);
            Marshal.StructureToPtr(limits, limitInfoPointer, false);
            if (!SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                limitInfoPointer,
                (uint)limitsSize))
            {
                ThrowLastError("SetInformationJobObject");
            }

            IntPtr stdInput = GetStdHandle(STD_INPUT_HANDLE);
            IntPtr stdOutput = GetStdHandle(STD_OUTPUT_HANDLE);
            IntPtr stdError = GetStdHandle(STD_ERROR_HANDLE);
            List<IntPtr> inheritedHandles = new List<IntPtr>();
            foreach (IntPtr handle in new IntPtr[] { stdInput, stdOutput, stdError })
            {
                if (handle == IntPtr.Zero || handle == new IntPtr(-1)) continue;
                if (!inheritedHandles.Contains(handle)) inheritedHandles.Add(handle);
            }
            if (inheritedHandles.Count == 0)
            {
                throw new InvalidOperationException("No valid standard handles were provided.");
            }
            foreach (IntPtr handle in inheritedHandles)
            {
                if (!SetHandleInformation(handle, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT))
                {
                    ThrowLastError("SetHandleInformation");
                }
            }

            IntPtr attributeSize = IntPtr.Zero;
            InitializeProcThreadAttributeList(IntPtr.Zero, 2, 0, ref attributeSize);
            attributeList = Marshal.AllocHGlobal(attributeSize);
            if (!InitializeProcThreadAttributeList(attributeList, 2, 0, ref attributeSize))
            {
                ThrowLastError("InitializeProcThreadAttributeList");
            }
            attributeListInitialized = true;
            jobValue = Marshal.AllocHGlobal(IntPtr.Size);
            Marshal.WriteIntPtr(jobValue, job);
            if (!UpdateProcThreadAttribute(
                attributeList,
                0,
                new IntPtr(PROC_THREAD_ATTRIBUTE_JOB_LIST),
                jobValue,
                new IntPtr(IntPtr.Size),
                IntPtr.Zero,
                IntPtr.Zero))
            {
                ThrowLastError("UpdateProcThreadAttribute(JOB_LIST)");
            }
            handleList = Marshal.AllocHGlobal(IntPtr.Size * inheritedHandles.Count);
            for (int index = 0; index < inheritedHandles.Count; index++)
            {
                Marshal.WriteIntPtr(handleList, index * IntPtr.Size, inheritedHandles[index]);
            }
            if (!UpdateProcThreadAttribute(
                attributeList,
                0,
                new IntPtr(PROC_THREAD_ATTRIBUTE_HANDLE_LIST),
                handleList,
                new IntPtr(IntPtr.Size * inheritedHandles.Count),
                IntPtr.Zero,
                IntPtr.Zero))
            {
                ThrowLastError("UpdateProcThreadAttribute(HANDLE_LIST)");
            }

            STARTUPINFOEX startup = new STARTUPINFOEX();
            startup.StartupInfo.cb = Marshal.SizeOf(typeof(STARTUPINFOEX));
            startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
            startup.StartupInfo.hStdInput = stdInput;
            startup.StartupInfo.hStdOutput = stdOutput;
            startup.StartupInfo.hStdError = stdError;
            startup.lpAttributeList = attributeList;

            uint flags = CREATE_SUSPENDED |
                CREATE_UNICODE_ENVIRONMENT |
                EXTENDED_STARTUPINFO_PRESENT;
            if (!CreateProcess(
                executable,
                new StringBuilder(commandLine),
                IntPtr.Zero,
                IntPtr.Zero,
                true,
                flags,
                IntPtr.Zero,
                workingDirectory,
                ref startup,
                out process))
            {
                ThrowLastError("CreateProcess");
            }
            if (ResumeThread(process.hThread) == UInt32.MaxValue)
            {
                ThrowLastError("ResumeThread");
            }
            CloseHandle(process.hThread);
            process.hThread = IntPtr.Zero;

            bool cancelled = false;
            while (true)
            {
                uint wait = WaitForSingleObject(process.hProcess, 50);
                if (wait == WAIT_OBJECT_0) break;
                if (wait == WAIT_FAILED) ThrowLastError("WaitForSingleObject");
                if (wait != WAIT_TIMEOUT) throw new InvalidOperationException("Unexpected wait result.");
                uint parentWait = WaitForSingleObject(parentProcess, 0);
                if (parentWait == WAIT_FAILED) ThrowLastError("WaitForSingleObject(parent)");
                if (File.Exists(cancelPath) || parentWait == WAIT_OBJECT_0)
                {
                    cancelled = true;
                    break;
                }
            }

            uint targetExitCode = 1;
            if (!cancelled && !GetExitCodeProcess(process.hProcess, out targetExitCode))
            {
                ThrowLastError("GetExitCodeProcess");
            }
            bool cleanupOk = StopAndDrainJob(job, cleanupTimeoutMs);
            if (cancelled)
            {
                WaitForSingleObject(process.hProcess, (uint)Math.Max(250, cleanupTimeoutMs));
                targetExitCode = 1;
            }
            return new Tex64JobResult {
                TargetExitCode = unchecked((int)targetExitCode),
                CleanupOk = cleanupOk,
                Cancelled = cancelled
            };
        }
        finally
        {
            if (process.hThread != IntPtr.Zero) CloseHandle(process.hThread);
            if (process.hProcess != IntPtr.Zero) CloseHandle(process.hProcess);
            if (parentProcess != IntPtr.Zero) CloseHandle(parentProcess);
            if (attributeListInitialized) DeleteProcThreadAttributeList(attributeList);
            if (attributeList != IntPtr.Zero) Marshal.FreeHGlobal(attributeList);
            if (jobValue != IntPtr.Zero) Marshal.FreeHGlobal(jobValue);
            if (handleList != IntPtr.Zero) Marshal.FreeHGlobal(handleList);
            if (limitInfoPointer != IntPtr.Zero) Marshal.FreeHGlobal(limitInfoPointer);
            if (job != IntPtr.Zero) CloseHandle(job);
        }
    }
}
'@

try {
  Add-Type -TypeDefinition $source -Language CSharp
  $result = [Tex64JobRunner]::Run(
    [string]$config.executable,
    [string]$config.commandLine,
    [string]$config.workingDirectory,
    [string]$config.cancelPath,
    [int]$config.parentPid,
    [int]$config.cleanupTimeoutMs
  )
  Write-JobStatus -Path ([string]$config.statusPath) -Value ([ordered]@{
    cleanupOk = [bool]$result.CleanupOk
    cancelled = [bool]$result.Cancelled
    targetExitCode = [int]$result.TargetExitCode
    error = ""
  })
  if (-not $result.CleanupOk) {
    [Console]::Error.WriteLine("[tex64-job] Windows Job Object cleanup could not be verified.")
    exit 253
  }
  exit ([int]$result.TargetExitCode)
}
catch {
  $message = [string]$_.Exception.Message
  try {
    Write-JobStatus -Path ([string]$config.statusPath) -Value ([ordered]@{
      cleanupOk = $false
      cancelled = $false
      targetExitCode = $null
      error = $message
    })
  }
  catch {
    # The parent treats a missing status record as an unverified cleanup.
  }
  [Console]::Error.WriteLine("[tex64-job] $message")
  exit 254
}
