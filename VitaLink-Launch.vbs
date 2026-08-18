Set shell = CreateObject("WScript.Shell")
shell.CurrentDirectory = "D:\SW\Vitalink"

Dim running
running = False

On Error Resume Next
Set http = CreateObject("MSXML2.XMLHTTP")
http.Open "GET", "http://localhost:8765/index.html", False
http.Send
If Err.Number = 0 And http.Status = 200 Then
  running = True
End If
On Error Goto 0

If Not running Then
  shell.Run """C:\Users\widib\AppData\Local\Python\pythoncore-3.14-64\python.exe"" -m http.server 8765", 0, False
  WScript.Sleep 1000
End If

Dim cacheBust
cacheBust = Year(Now) & Right("0" & Month(Now),2) & Right("0" & Day(Now),2) & Right("0" & Hour(Now),2) & Right("0" & Minute(Now),2) & Right("0" & Second(Now),2)
shell.Run "http://localhost:8765/index.html?t=" & cacheBust, 1, False
