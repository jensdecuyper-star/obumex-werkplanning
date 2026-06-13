// Testset voor de Obumex-planningstool kernlogica + cloud-merge.
// Run: node tests.js   (haalt de functies uit index.html)
const fs=require('fs');
const path=process.argv[2]||'work.html';
const s=fs.readFileSync(path,'utf8');
function grab(name){const k='function '+name+'(';const i=s.indexOf(k);if(i<0)throw('mist '+name);let b=s.indexOf('{',i),d=0,j=b;for(;j<s.length;j++){const c=s[j];if(c==='{')d++;else if(c==='}'){d--;if(d===0){j++;break;}}}return s.slice(i,j);}
let _pass=0,_fail=0;
function eq(act,exp,msg){var a=JSON.stringify(act),e=JSON.stringify(exp);if(a===e){_pass++;}else{_fail++;console.log('  ✗ '+msg+'\n     verwacht '+e+'\n     kreeg    '+a);}}
function ok(c,msg){if(c){_pass++;}else{_fail++;console.log('  ✗ '+msg);}}

// ---- merge-functies (puur) ----
eval(grab('_mEq'));eval(grab('_projectKeys'));eval(grab('_mergeMap'));eval(grab('_mergeJobs'));eval(grab('_mergeAppend'));
var CLOUD_KEYS=['jobs','plan','bw','cnc','dayHrs','workDays','events','history','holidays','cncBacklog','cncLastPonrs','bankBacklog','bankLastPonrs'];
eval(grab('threeWayMerge'));

console.log('MERGE-tests:');
// T1 plan: andere cellen → beide behouden
var m=threeWayMerge({plan:{A:[1],B:[2]}},{plan:{A:[1,9],B:[2]}},{plan:{A:[1],B:[2,8]}});
eq(m.plan,{A:[1,9],B:[2,8]},'T1 plan: gelijktijdige moves in verschillende cellen');
// T2 jobs: andere jobs bewerkt → beide
var m2=threeWayMerge({jobs:[{id:'j1',hrs:8},{id:'j2',hrs:8}]},{jobs:[{id:'j1',hrs:10},{id:'j2',hrs:8}]},{jobs:[{id:'j1',hrs:8},{id:'j2',hrs:6}]});
eq(m2.jobs.find(j=>j.id==='j1').hrs,10,'T2 jobs: onze edit j1');
eq(m2.jobs.find(j=>j.id==='j2').hrs,6,'T2 jobs: hun edit j2');
// T3 theirs nieuwe job behouden
var m3=threeWayMerge({jobs:[{id:'j1'}]},{jobs:[{id:'j1'}]},{jobs:[{id:'j1'},{id:'j2'}]});
ok(m3.jobs.some(j=>j.id==='j2'),'T3 jobs: nieuwe job van collega behouden');
// T4 onze verwijdering respecteren
var m4=threeWayMerge({jobs:[{id:'j1'},{id:'j2'}]},{jobs:[{id:'j1'}]},{jobs:[{id:'j1'},{id:'j2'}]});
ok(!m4.jobs.some(j=>j.id==='j2'),'T4 jobs: onze verwijdering wint');
// T5 backlog append van beiden
var m5=threeWayMerge({cncBacklog:[{m:'a',items:1}]},{cncBacklog:[{m:'a',items:1},{m:'b',items:2}]},{cncBacklog:[{m:'a',items:1},{m:'c',items:3}]});
eq(m5.cncBacklog.map(e=>e.m),['a','c','b'],'T5 backlog: beide meetpunten behouden (theirs+ours)');
// T6 scalar
var m6=threeWayMerge({workDays:[1,2,3,4,5]},{workDays:[1,2,3,4,5,6]},{workDays:[1,2,3,4,5]});
eq(m6.workDays,[1,2,3,4,5,6],'T6 scalar: onze wijziging wint');
var m7=threeWayMerge({workDays:[1,2,3,4,5]},{workDays:[1,2,3,4,5]},{workDays:[1,2,3]});
eq(m7.workDays,[1,2,3],'T7 scalar: ongewijzigd → neem die van collega');
// T8 events map
var m8=threeWayMerge({events:{}},{events:{'p1_x':{type:'sick'}}},{events:{}});
eq(m8.events,{'p1_x':{type:'sick'}},'T8 events: onze afwezigheid behouden');

// ---- kernlogica ----
console.log('KERNLOGICA-tests:');
var _ins=null,_dhead={},_spans={},_parts={};
var S={wo:0,workDays:[1,2,3,4,5],holidays:{},events:{},dayHrs:8,jobs:[],plan:{},bw:[{id:'p1',name:'A',hrs:8}],cnc:[]};
eval(['wdates','woOf','diOf','gdate','gToday','pkey','getPlan','personHrs','isHoliday','dayUsed','allPeople','placePlan','placeOnNextWorkDay','spillOver','nextWorkdayG','computeSpans'].map(grab).join('\n'));
// roundtrip
var rt=true;for(var g=-20;g<60;g++){if(woOf(g)*7+diOf(g)!==g)rt=false;}ok(rt,'dag-index roundtrip woOf/diOf');
var mon=woOf(gToday())*7; ok(gdate(mon).getDay()===1,'maandag-index klopt');
// spillOver: 3x4u op cap8 → 2 blijven, 1 door
S.jobs=[{id:'a',hrs:4},{id:'b',hrs:4},{id:'c',hrs:4}];S.plan={};S.plan[pkey('p1',mon)]=['a','b','c'];spillOver('p1',mon);
eq(S.plan[pkey('p1',mon)],['a','b'],'spillOver: 2 blijven op de dag');
eq(S.plan[pkey('p1',mon+1)],['c'],'spillOver: 3e schuift door');
// computeSpans: 24u → 8/8/8
S.jobs=[{id:'big',hrs:24}];S.plan={};S.plan[pkey('p1',mon)]=['big'];computeSpans();
eq(_dhead['big'],8,'span: kop 8u');eq(_parts['big'],3,'span: 3 delen');
eq((_spans['p1|'+(mon+1)]||[]).map(x=>x.hrs),[8],'span: dag2 8u');
// weekend skip
var fri=mon+4;S.jobs=[{id:'x',hrs:16}];S.plan={};S.plan[pkey('p1',fri)]=['x'];computeSpans();
ok(!_spans['p1|'+(fri+1)],'span: zaterdag overgeslagen');ok(_spans['p1|'+(fri+3)],'span: doorgeschoven naar maandag');

console.log('\nRESULTAAT: '+_pass+' geslaagd, '+_fail+' gefaald');
process.exit(_fail?1:0);
