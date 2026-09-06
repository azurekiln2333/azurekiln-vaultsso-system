# -*- coding: utf-8 -*-
"""
安全校验回归矩阵：需要先起一个（memory 模式）服务实例，然后运行：
  DB_DRIVER=memory PORT=3596 JWT_SECRET=test node server.js > server.log 2>&1 &
  python scripts/security-matrix.py http://127.0.0.1:3596 server.log
所有用例必须全部 PASS，任何 FAIL 都意味着某条校验被绕过。
"""
import json, subprocess, re, sys, time

BASE = sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:3596'
LOG = sys.argv[2] if len(sys.argv) > 2 else 'server.log'
results = []


def check(name, ok, note=''):
    results.append((name, ok, note))

def curl(args):
    return subprocess.run(['curl', '-s'] + args, capture_output=True, text=True).stdout

def status_of(args):
    return subprocess.run(['curl', '-s', '-o', '/dev/null', '-w', '%{http_code}'] + args, capture_output=True, text=True).stdout

def captcha():
    d = json.loads(curl([f'{BASE}/api/captcha']))
    return d['id'], ''.join(re.findall(r'>([a-z0-9])</text>', d['svg']))

def last_code(purpose):
    for _ in range(20):
        lines = [l for l in open(LOG, encoding='utf-8', errors='ignore') if f'purpose={purpose}' in l]
        if lines:
            return lines[-1].strip().split('code=')[-1]
        time.sleep(0.3)
    raise AssertionError(f'no dev code for {purpose}')

# 0) 开启全部防护（用管理员会话）
d = json.loads(curl([f'{BASE}/api/captcha'])); cid, ctext = d['id'], ''.join(re.findall(r'>([a-z0-9])</text>', d['svg']))
r = json.loads(curl(['-c', '.tmp-a.txt', '-X', 'POST', f'{BASE}/oauth2/authorize',
                     '-d', f'username=demo@vaultsso.com&password=demo123&captcha_id={cid}&captcha_code={ctext}']))
check('管理员登录', r.get('message_key') == 'auth.login_success', str(r)[:80])
put_status = status_of(['-b', '.tmp-a.txt', '-X', 'PUT', f'{BASE}/api/admin/security', '-H', 'Content-Type: application/json',
                        '-d', '{"captchaLogin":true,"captchaRegister":true,"loginEmailCode":true}'])
check('开启防护开关', put_status == '200', put_status)
cfg = json.loads(curl([f'{BASE}/api/auth/config']))
check('配置确认生效', cfg['captchaLogin'] and cfg['captchaRegister'] and cfg['loginEmailCode'], str(cfg))

# 1) 登录-无验证码 → 拒
r = json.loads(curl(['-X', 'POST', f'{BASE}/oauth2/authorize', '-d', 'username=demo@vaultsso.com&password=demo123']))
check('登录·无验证码 → 拒', r.get('error_key') in ('captcha.expired', 'captcha.invalid'), r.get('error_key'))

# 2) 登录-错验证码 → 拒
cid, ctext = captcha()
r = json.loads(curl(['-X', 'POST', f'{BASE}/oauth2/authorize', '-d', f'username=demo@vaultsso.com&password=demo123&captcha_id={cid}&captcha_code=zzzz']))
check('登录·错验证码 → 拒', r.get('error_key') in ('captcha.invalid', 'captcha.expired'), r.get('error_key'))

# 3) 登录-对验证码+对密码 → 邮箱码步骤
cid, ctext = captcha()
r = json.loads(curl(['-X', 'POST', f'{BASE}/oauth2/authorize', '-d', f'username=demo@vaultsso.com&password=demo123&captcha_id={cid}&captcha_code={ctext}']))
check('登录·对验证码 → 邮箱码步骤', r.get('require_email_code') is True, str(r)[:60])
email_code = last_code('login')

# 4) 登录-错邮箱码 → 拒
cid, ctext = captcha()
r = json.loads(curl(['-X', 'POST', f'{BASE}/oauth2/authorize', '-d', f'username=demo@vaultsso.com&password=demo123&captcha_id={cid}&captcha_code={ctext}&email_code=000000']))
check('登录·错邮箱码 → 拒', r.get('error_key') == 'email_code.invalid', r.get('error_key'))

# 5) 登录-验证码+邮箱码全对 → 成功
cid, ctext = captcha()
r = json.loads(curl(['-X', 'POST', f'{BASE}/oauth2/authorize', '-d', f'username=demo@vaultsso.com&password=demo123&captcha_id={cid}&captcha_code={ctext}&email_code={email_code}']))
check('登录·全对 → 成功', r.get('message_key') == 'auth.login_success', str(r)[:60])

# 6) 注册-错图形验证码 → 拒
curl(['-X', 'POST', f'{BASE}/api/email-verification/send', '-d', 'email=newuser@test.com&purpose=register'])
reg_code = last_code('register')
r = json.loads(curl(['-X', 'POST', f'{BASE}/oauth2/register', '-d', f'name=T&email=newuser@test.com&password=GoodPass123&confirm_password=GoodPass123&email_code={reg_code}&captcha_id=x&captcha_code=zz']))
check('注册·错验证码 → 拒', r.get('error_key') in ('captcha.invalid', 'captcha.expired'), r.get('error_key'))

# 7) 注册-错邮箱码 → 拒
cid, ctext = captcha()
r = json.loads(curl(['-X', 'POST', f'{BASE}/oauth2/register', '-d', f'name=T&email=newuser@test.com&password=GoodPass123&confirm_password=GoodPass123&email_code=000000&captcha_id={cid}&captcha_code={ctext}']))
check('注册·错邮箱码 → 拒', r.get('error_key') == 'email_code.invalid', r.get('error_key'))

# 8) 注册-全对 → 成功
cid, ctext = captcha()
r = json.loads(curl(['-X', 'POST', f'{BASE}/oauth2/register', '-d', f'name=T&email=newuser@test.com&password=GoodPass123&confirm_password=GoodPass123&email_code={reg_code}&captcha_id={cid}&captcha_code={ctext}']))
check('注册·全对 → 成功', r.get('error_key') is None and 'password' not in r, str(r)[:60])

# 9) 注册-弱密码 → 拒
cid, ctext = captcha()
r = json.loads(curl(['-X', 'POST', f'{BASE}/oauth2/register', '-d', f'name=W&email=weak@test.com&password=123456&confirm_password=123456&email_code=000000&captcha_id={cid}&captcha_code={ctext}']))
check('注册·弱密码 → 拒', r.get('error_key') == 'validation.password.weak', r.get('error_key'))

# 10) 权限-匿名访问管理 API → 401
check('权限·匿名访问管理 API → 401', status_of([f'{BASE}/api/admin/security']) == '401')

# 11) 权限-普通用户访问管理 API → 403（含邮箱码两步）
cid, ctext = captcha()
r = json.loads(curl(['-X', 'POST', f'{BASE}/oauth2/authorize', '-d', f'username=newuser@test.com&password=GoodPass123&captcha_id={cid}&captcha_code={ctext}']))
check('权限-普通用户密码步 → 邮箱码', r.get('require_email_code') is True, str(r)[:60])
user_email_code = last_code('login')
cid, ctext = captcha()
r = json.loads(curl(['-c', '.tmp-b.txt', '-X', 'POST', f'{BASE}/oauth2/authorize', '-d', f'username=newuser@test.com&password=GoodPass123&captcha_id={cid}&captcha_code={ctext}&email_code={user_email_code}']))
check('权限-普通用户登录', r.get('message_key') == 'auth.login_success', str(r)[:60])
check('权限·普通用户访问管理 API → 403', status_of(['-b', '.tmp-b.txt', f'{BASE}/api/admin/security']) == '403')
check('权限·普通用户改安全设置 → 403', status_of(['-b', '.tmp-b.txt', '-X', 'PUT', f'{BASE}/api/admin/security', '-H', 'Content-Type: application/json', '-d', '{}']) == '403')

# 12) 越权-普通用户吊销他人会话 → 404/403（只能操作自己）
check('越权·普通用户重置他人TOTP → 403', status_of(['-b', '.tmp-b.txt', '-X', 'POST', f'{BASE}/api/users/xxx/totp/reset']) == '403')

# 13) CORS-恶意 Origin 无允许头
head = subprocess.run(['curl', '-s', '-D', '-', '-o', '/dev/null', '-H', 'Origin: https://evil.example.com', f'{BASE}/api/auth/config'], capture_output=True, text=True).stdout
check('CORS·恶意 Origin → 无允许头', 'Access-Control-Allow-Origin' not in head)

# 14) CORS-同源 Origin 放行
head = subprocess.run(['curl', '-s', '-D', '-', '-o', '/dev/null', '-H', f'Origin: {BASE}', f'{BASE}/api/auth/config'], capture_output=True, text=True).stdout
check('CORS·同源 Origin → 放行', 'Access-Control-Allow-Origin' in head)

# 15) 审计-管理员动作与注册事件
logs = json.loads(curl(['-b', '.tmp-a.txt', f'{BASE}/api/admin/security/logs?limit=50']))
check('审计·管理员设置变更已记录', any(l['result'] == 'admin_action' for l in logs))
check('审计·注册事件已记录', any(l['result'] == 'register' for l in logs))
check('审计·验证码失败已记录', any(l['result'] == 'captcha_failed' for l in logs))

# 16) TOTP 错码计入锁定（开 TOTP、错 5 次 → 锁定）
curl(['-b', '.tmp-a.txt', '-X', 'PUT', f'{BASE}/api/admin/security', '-H', 'Content-Type: application/json', '-d', '{"loginMaxAttempts":3}'])
r = json.loads(curl(['-b', '.tmp-a.txt', '-X', 'POST', f'{BASE}/api/account/totp/setup']))
secret = r['secret']
code_ok = subprocess.run(['node', '-e', '''
const crypto = require('crypto');
const A='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const clean=%r.toUpperCase().replace(/[^A-Z2-7]/g,'');
const bytes=[]; let buf=0,bits=0;
for(const c of clean){const v=A.indexOf(c); buf=(buf<<5)|v; bits+=5; if(bits>=8){bits-=8;bytes.push((buf>>>bits)&0xff);}}
const key=Buffer.from(bytes);
const counter=Math.floor(Date.now()/1000/30);
const cb=Buffer.alloc(8); cb.writeUInt32BE(Math.floor(counter/0x100000000),0); cb.writeUInt32BE(counter%%0x100000000,4);
const dg=crypto.createHmac('sha1',key).update(cb).digest(); const o=dg[dg.length-1]&0xf;
const bin=((dg[o]&0x7f)<<24)|((dg[o+1]&0xff)<<16)|((dg[o+2]&0xff)<<8)|(dg[o+3]&0xff);
console.log(String(bin%%1000000).padStart(6,'0'));
''' % (repr(secret),)], capture_output=True, text=True).stdout.strip()
curl(['-b', '.tmp-a.txt', '-X', 'POST', f'{BASE}/api/account/totp/enable', '-H', 'Content-Type: application/json', '-d', f'{{"code":"{code_ok}"}}'])
for _ in range(3):
    cid, ctext = captcha()
    r = json.loads(curl(['-X', 'POST', f'{BASE}/oauth2/authorize', '-d', f'username=demo@vaultsso.com&password=demo123&captcha_id={cid}&captcha_code={ctext}&totp_code=000000']))
    check('锁定·TOTP 错码被拒', r.get('error_key') == 'auth.totp.invalid', r.get('error_key'))
cid, ctext = captcha()
r = json.loads(curl(['-X', 'POST', f'{BASE}/oauth2/authorize', '-d', f'username=demo@vaultsso.com&password=demo123&captcha_id={cid}&captcha_code={ctext}&totp_code=000000']))
check('锁定·第 4 次 → 锁定', r.get('error_key') == 'auth.locked', r.get('error_key'))
curl(['-b', '.tmp-a.txt', '-X', 'PUT', f'{BASE}/api/admin/security', '-H', 'Content-Type: application/json', '-d', '{"loginMaxAttempts":5}'])

passed = sum(1 for _, ok, _ in results if ok)
for name, ok, note in results:
    print(('PASS' if ok else 'FAIL'), name, ('[' + note + ']') if note else '')
print(f'\n{passed}/{len(results)} passed')
sys.exit(0 if passed == len(results) else 1)
