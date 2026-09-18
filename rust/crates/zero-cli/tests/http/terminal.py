"""Bounded real terminal runner for the scoped-HTTP forwarding fixture."""
import errno,fcntl,json,os,pty,re,select,signal,struct,subprocess,termios,time

def current_screen(data):
    cells=[[" "]*140 for _ in range(38)];row=col=0
    for token in re.findall(r"\x1b\[[0-?]*[ -/]*[@-~]|[^\x1b]+",data.decode("utf-8","ignore")):
        if token.startswith("\x1b["):
            body,code=token[2:-1],token[-1]
            if body.startswith("?") or code=="m":continue
            nums=[int(n) if n else 0 for n in body.split(";")];n=nums[0] or 1
            if code in ("H","f"):row=max(0,nums[0]-1);col=max(0,(nums[1] if len(nums)>1 else 1)-1)
            elif code=="J" and nums[0] in (2,3):cells=[[" "]*140 for _ in range(38)]
            elif code=="K" and row<38:
                lo,hi=(0,140) if nums[0]==2 else ((0,col+1) if nums[0]==1 else (col,140))
                for x in range(lo,min(hi,140)):cells[row][x]=" "
            elif code=="A":row=max(0,row-n)
            elif code=="B":row+=n
            elif code=="C":col+=n
            elif code=="D":col=max(0,col-n)
            continue
        for c in token:
            if c=="\r":col=0
            elif c=="\n":row+=1
            elif c>=" ":
                if row<38 and col<140:cells[row][col]=c
                col+=1
    return "\n".join("".join(line) for line in cells)

def run_terminal(args,env,models,targets,query,config):
    master,slave=pty.openpty();original=termios.tcgetattr(slave)
    fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack("HHHH",38,140,0,0))
    environment=env.copy();environment["TERM"]="xterm-256color"
    proc=None;screen=bytearray();children=[];handles=[]
    def pump():
        if select.select([master],[],[],0.02)[0]:
            try:screen.extend(os.read(master,65536))
            except OSError as e:
                if e.errno!=errno.EIO:raise
        assert len(screen)<8*1024*1024
    def until(predicate,label):
        end=time.monotonic()+10
        while not predicate():
            assert time.monotonic()<end,(label,current_screen(screen),proc.poll())
            assert proc.poll() is None,(label,current_screen(screen),proc.returncode)
            pump()
    try:
        proc=subprocess.Popen(args,env=environment,stdin=slave,stdout=slave,stderr=slave,start_new_session=True)
        until(lambda:"Ready" in current_screen(screen),"ready")
        with open("/proc/%d/task/%d/children"%(proc.pid,proc.pid)) as f:children=[int(p) for p in f.read().split()]
        handles=[os.pidfd_open(pid) for pid in children];assert children
        os.write(master,"\x1b[200~Observe λ target\nretain scope\x1b[201~".encode())
        for _ in range(5):pump()
        assert not models and not targets and query("SELECT count(*) FROM agent_inputs")[0][0]==0
        os.write(master,b"\r")
        until(lambda:"HTTP observation retained; no safety verdict" in current_screen(screen) and "Live provisional" not in current_screen(screen),"completed HTTP conversation")
        assert len(models)==2 and len(targets)==1
        http_operation=query("SELECT id FROM operations WHERE json_extract(payload,'$.kind')='agent_http'")[0][0]
        inspection=subprocess.run([config["binary"],"--state",config["state"],"--http-profiles","/must-not-read","http","show","--session",config["session"],"--operation",http_operation],env=environment,capture_output=True,timeout=5)
        assert inspection.returncode==0,inspection.stderr
        assert json.loads(inspection.stdout)["operation_id"]==http_operation
        assert len(models)==2 and len(targets)==1
        os.write(master,b"\x11")
        end=time.monotonic()+10
        while proc.poll() is None:
            assert time.monotonic()<end,"terminal shutdown";pump()
        for _ in range(3):pump()
        assert proc.returncode==0,(proc.returncode,current_screen(screen))
        assert termios.tcgetattr(slave)==original
        assert b"\x1b[?1049l" in screen and b"\x1b[?2004l" in screen
        assert not any(os.path.exists("/proc/%d"%pid) for pid in children)
        return subprocess.CompletedProcess(args,proc.returncode,bytes(screen),b"")
    finally:
        if proc is not None and proc.poll() is None:
            for handle in handles:
                try:signal.pidfd_send_signal(handle,signal.SIGKILL)
                except ProcessLookupError:pass
            os.killpg(proc.pid,signal.SIGKILL);proc.wait(timeout=3)
        for handle in handles:os.close(handle)
        os.close(master);os.close(slave)
