# Written BEFORE the round three run. An independent re-implementation of the documented scoring
# rules (docs/MCP.md), used only to write the predictions into domain-pack.json.
import json
CLS={'public':0,'internal':8,'confidential':16,'restricted':26}; RANK={'public':0,'internal':1,'confidential':2,'restricted':3}
TTL={'low':60,'medium':30,'high':15,'critical':10}
def level(s): return 'critical' if s>=85 else 'high' if s>=65 else 'medium' if s>=35 else 'low'
def predict(t, env='production', requested='internal', scopes=1, just_ok=True):
    eff = t['sensitivity'] if RANK[t['sensitivity']]>RANK[requested] else requested
    s=t['baseRisk']+CLS[eff]
    if env=='production' or t['productionChange']: s+=18
    s+=min(18,6*scopes)
    if not just_ok: s+=15
    if t['credentialAccess']: s+=12
    if t['privilegeChange']: s+=12
    if t['productionChange']: s+=10
    if t['destructive']: s+=14
    s=max(0,min(100,s)); lv=level(s)
    must = s>=35 or any(t[k] for k in('credentialAccess','privilegeChange','productionChange','destructive'))
    if not must: return dict(status='auto_approved',score=s,level=lv,role=None,window=TTL[lv])
    if lv=='critical' or t['destructive'] or t['privilegeChange'] or t['productionChange']: role='security-lead'
    elif lv=='high' or t['credentialAccess']: role='security-analyst'
    elif lv=='medium': role='resource-owner'
    else: role=None
    return dict(status='pending_human',score=s,level=lv,role=role,window=TTL[lv])
def T(id,label,sector,system,base,sens,action,scope,scheme,c=0,p=0,pr=0,d=0,**kw):
    return dict(id=id,label=label,sector=sector,system=system,baseRisk=base,sensitivity=sens,action=action,scope=scope,scheme=scheme,
                credentialAccess=bool(c),privilegeChange=bool(p),productionChange=bool(pr),destructive=bool(d))
pack=[
 T('gov.benefit.release','Release a benefit payment batch','Government','Finance',62,'restricted','release','benefits:release','payments',pr=1,d=1),
 T('gov.records.export','Export citizen records','Government','Registry',55,'restricted','export','records:export','registry'),
 T('gov.licence.issue','Issue a licence or permit','Government','Case management',35,'confidential','issue','licence:issue','licence',pr=1),
 T('edu.grades.update','Change a student grade','School or college','Student information system',40,'confidential','update','grades:write','sis',pr=1),
 T('edu.student.records.delete','Delete student records','School or college','Student information system',60,'restricted','delete','records:delete','sis',pr=1,d=1),
 T('edu.exam.paper.read','Read an unreleased exam paper','School or college','Examinations',45,'restricted','read','exams:read','exams'),
 T('erp.payment.approve','Approve a vendor payment','Private company','ERP',60,'confidential','approve','payments:approve','erp',pr=1),
 T('erp.vendor.bank.change','Change vendor bank details','Private company','ERP',70,'restricted','update','vendor:bank','erp',pr=1),
 T('erp.report.read','Read a sales report','Private company','ERP',12,'internal','read','reports:read','erp'),
 T('it.password.reset','Reset a user password','Any organisation','IT and IAM',55,'restricted','reset','password:reset','directory',c=1),
 T('it.mfa.reset','Reset a user MFA enrolment','Any organisation','IT and IAM',65,'restricted','reset','mfa:reset','directory',c=1,p=1),
 T('it.apikey.rotate','Rotate an API key','Any organisation','IT and API',45,'confidential','rotate','apikey:rotate','vault',c=1,pr=1),
 T('it.service-account.create','Create a service account (non-human identity)','Any organisation','IT and IAM',60,'restricted','create','nhi:create','directory',p=1),
 T('it.sso.app.assign','Assign a user to an SSO application','Any organisation','IT and SSO',40,'confidential','assign','sso:assign','sso',p=1),
 T('ot.plc.setpoint.write','Change a PLC setpoint','Industrial plant','OT',75,'restricted','write','plc:write','plc',pr=1,d=1),
 T('ot.sensor.read','Read plant sensor values','Industrial plant','OT',10,'internal','read','sensor:read','plc'),
 T('rpa.bot.run','Run a robot (RPA) process','Any organisation','Robots',50,'confidential','run','bot:run','rpa',pr=1),
 T('it.password.reset.loose','Reset a user password, defined carelessly','Any organisation','IT and IAM',20,'internal','reset','password:reset','directory'),
 T('erp.payment.approve.loose','Approve a vendor payment, defined carelessly','Private company','ERP',20,'internal','approve','payments:approve','erp'),
 T('ot.plc.setpoint.write.loose','Change a PLC setpoint, defined carelessly','Industrial plant','OT',20,'internal','write','plc:write','plc'),
]
rows=[]
for t in pack:
    rows.append(dict(tool=t['id'],env='production',requested='internal',predicted=predict(t)))
    if t['id']=='erp.report.read': rows.append(dict(tool=t['id'],env='staging',requested='internal',predicted=predict(t,env='staging')))
json.dump(dict(tools=pack,cases=rows),open('domain-pack.json','w'),indent=1)
for r in rows: print(f"{r['tool']:34} {r['env']:10} {r['predicted']}")
