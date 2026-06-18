#!/usr/bin/env python3
"""
plaatsing-sync.py with hardcoded Firebase config
"""

import json
import csv
import os
import re
from datetime import datetime, timedelta
from pathlib import Path
import openpyxl
import requests
# HARDCODED Firebase config fallback (public API key)
FIREBASE_CONFIG_FALLBACK = {
    "apiKey": "AIzaSyBZJRq5DyUMmfS0sAqSs1Uo6rxhYMVhzKg",
    "projectId": "obumex-werkplanning",
}


def isoWeekKey(d):
    """ISO week key: YYYY-Www"""
    jan4 = datetime(d.year, 1, 4)
    wk1Mon = jan4 - timedelta(days=jan4.weekday())
    diffDays = (d - wk1Mon).days
    weekNum = diffDays // 7 + 1
    return f"{d.year}-W{weekNum:02d}"

# HARDCODED Firebase config (public API key)
fb_config = {
    "apiKey": "AIzaSyBZJRq5DyUMmfS0sAqSs1Uo6rxhYMVhzKg",
    "projectId": "obumex-werkplanning",
}

print('[plaatsing-sync] Start')
print('[plaatsing-sync] Using hardcoded Firebase config')

# Paths
cwd = Path.cwd()
excel_file = cwd / 'programmering_cnc.xlsx'
csv_file = cwd / '_afgewerkt_clean.csv'

# Read plaatsingsdagen from Excel
plaatsing_map = {}
try:
    wb = openpyxl.load_workbook(excel_file, data_only=False)
    ws = wb['Programmeringslijst']
    
    headers = {}
    for col_idx, cell in enumerate(ws[3], 1):
        if cell.value:
            headers[cell.value.strip()] = col_idx
    
    if 'PLAATSINGSDAGEN' not in headers:
        print('[plaatsing-sync] ERROR: PLAATSINGSDAGEN column not found')
        exit(1)
    
    plaatsing_col = headers['PLAATSINGSDAGEN']
    project_col = headers.get('PROJECT', 2)
    fase_col = headers.get('FASE', 3)
    
    for row_idx in range(4, ws.max_row + 1):
        project = ws.cell(row_idx, project_col).value
        fase = ws.cell(row_idx, fase_col).value
        plaatsing = ws.cell(row_idx, plaatsing_col).value
        
        if project and fase and plaatsing:
            try:
                p = str(project).strip()
                f = str(int(float(fase))) if isinstance(fase, (int, float)) else str(fase).strip()
                pdays = float(plaatsing)
                plaatsing_map[(p, f)] = {'days': pdays}
            except:
                pass
    
    print(f'[plaatsing-sync] Read {len(plaatsing_map)} fases with plaatsingsdagen')
except Exception as e:
    print(f'[plaatsing-sync] Error reading Excel: {e}')
    exit(1)

# Read FileMaker afgewerkt data
afgewerkt_map = {}
try:
    if not os.path.exists(csv_file):
        print(f'[plaatsing-sync] No CSV found: {csv_file}')
    else:
        with open(csv_file, 'r', encoding='utf-8') as f:
            reader = csv.DictReader(f)
            for row in reader:
                try:
                    datum_str = row.get('datum', '')
                    proj_fase = row.get('project', '')
                    
                    if not datum_str or not proj_fase:
                        continue
                    
                    d = datetime.strptime(datum_str, '%Y-%m-%d')
                    week = isoWeekKey(d)
                    
                    parts = proj_fase.split('-')
                    if len(parts) >= 3:
                        project = '-'.join(parts[:-1])
                        fase = parts[-1]
                        afgewerkt_map[(project, fase)] = week
                except:
                    pass
        
        print(f'[plaatsing-sync] Read {len(afgewerkt_map)} afgewerkte fases')
except Exception as e:
    print(f'[plaatsing-sync] Error reading CSV: {e}')

# Match and calculate
per_week = {}
per_week_detail = {}

for (project, fase), pinfo in plaatsing_map.items():
    pdays = pinfo['days']
    if (project, fase) in afgewerkt_map:
        week = afgewerkt_map[(project, fase)]
        per_week[week] = per_week.get(week, 0) + pdays
        
        if week not in per_week_detail:
            per_week_detail[week] = []
        per_week_detail[week].append({
            'project': project,
            'fase': fase,
            'plaatsingsdagen': pdays
        })

print(f'[plaatsing-sync] Matched plaatsingsdagen for {len(per_week)} weeks')

# Build payload
total_plaatsing = sum(p['days'] for p in plaatsing_map.values())
payload = {
    'totaalPlaatsingsdagen': round(total_plaatsing, 1),
    'plaatsingPerWeek': {w: round(p, 1) for w, p in sorted(per_week.items())},
    'plaatsingFases': per_week_detail,
    'matchedFases': len(set(afgewerkt_map.keys()) & set(plaatsing_map.keys())),
    'totaleFases': len(plaatsing_map)
}

print(f'[plaatsing-sync] Payload: totaal={payload["totaalPlaatsingsdagen"]}d, matched={payload["matchedFases"]}')

# Write to Firebase
try:
    api_key = fb_config['apiKey']
    project_id = fb_config['projectId']
    
    url = f"https://firestore.googleapis.com/v1/projects/{project_id}/databases/(default)/documents/planning/plaatsing_live?key={api_key}"
    
    doc = {
        'fields': {
            'payload': {'stringValue': json.dumps(payload)},
            'updatedAt': {'timestampValue': datetime.utcnow().isoformat() + 'Z'}
        }
    }
    
    resp = requests.patch(url, json={'fields': doc['fields']}, timeout=10)
    
    if resp.status_code in (200, 201):
        print('[plaatsing-sync] ✓ Firestore written: planning/plaatsing_live')
    else:
        print(f'[plaatsing-sync] Firestore error: {resp.status_code}')
except Exception as e:
    print(f'[plaatsing-sync] Error writing Firestore: {e}')

print('[plaatsing-sync] Done')
