#!/usr/bin/env python3
"""Build one display zone from OpenStreetMap and public Mazo Maps place records.

Source data is never fetched by the browser. Existing map schema/layer names remain.
This does not generate or edit navigation/routing graphs.
"""
import argparse
import glob
import json
import math
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import uuid

import osmium

DISTRICTS = [
    ("ampara",7.20,81.60),("anuradhapura",8.40,80.40),("badulla",6.95,81.05),
    ("batticaloa",7.70,81.60),("colombo",6.90,79.90),("galle",6.10,80.20),
    ("gampaha",7.05,80.05),("hambantota",6.25,81.10),("jaffna",9.70,80.10),
    ("kalutara",6.55,80.05),("kandy",7.30,80.65),("kegalle",7.20,80.35),
    ("kilinochchi",9.40,80.40),("kurunegala",7.60,80.40),("mannar",8.90,79.95),
    ("matale",7.60,80.65),("matara",5.98,80.55),("monaragala",6.85,81.35),
    ("mullaitivu",9.10,80.70),("nuwara-eliya",6.95,80.75),
    ("polonnaruwa",7.90,81.00),("puttalam",8.05,79.90),
    ("ratnapura",6.70,80.50),("trincomalee",8.60,81.15),("vavuniya",8.75,80.50),
]
BBOX = [79.45,5.85,81.95,9.90]
ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
PUBLIC_KEYS = ("amenity","shop","tourism","historic","office","craft","healthcare")
SKIP_KEYS = {"house","apartments","residential","private","yes","no"}
MAX_FILE = 95_000_000

def owner(lon,lat):
    return min(range(len(DISTRICTS)), key=lambda i: ((lon-DISTRICTS[i][2])*.99)**2+(lat-DISTRICTS[i][1])**2)

def window(idx):
    # Only used to extract OSM input. Does NOT define road or routing connectivity.
    coords=[(lon,lat) for lat in [5.85+j*.02 for j in range(204)]
                    for lon in [79.45+i*.02 for i in range(126)]
                    if owner(lon,lat)==idx]
    return [round(min(p[0] for p in coords)-.05,3),round(min(p[1] for p in coords)-.05,3),
            round(max(p[0] for p in coords)+.05,3),round(max(p[1] for p in coords)+.05,3)]

def ulid(source):
    n=uuid.uuid5(uuid.NAMESPACE_URL,source).int
    out=""
    for _ in range(26):
        out=ALPHABET[n&31]+out
        n>>=5
    return out

def line(obj,props):
    return {"type":"Feature","geometry":obj,"properties":props}

def tags(obj):
    return dict(obj.tags)

def name_of(t):
    return t.get("name:en") or t.get("name") or ""

def feature_point(geom):
    typ=geom.get("type")
    co=geom.get("coordinates",[])
    if typ=="Point":return co[:2]
    if typ=="LineString" and co:return co[len(co)//2][:2]
    if typ in ("Polygon","MultiPolygon"):
        ring=co[0] if typ=="Polygon" else (co[0][0] if co and co[0] else [])
        if ring:return [sum(x[0] for x in ring)/len(ring),sum(x[1] for x in ring)/len(ring)]
    return None

def point_category(t):
    for key in PUBLIC_KEYS:
        value=t.get(key)
        if value and value not in SKIP_KEYS:
            if t.get("access") in ("private","no"):return None
            return value.replace("_"," ")
    return None

class Collector(osmium.SimpleHandler):
    def __init__(self,idx,tmp):
        super().__init__()
        self.idx=idx
        self.g=osmium.geom.GeoJSONFactory()
        self.tmp=tmp
        self.fp={key:open(tmp/(key+".geojsonseq"),"w",encoding="utf8")
                 for key in ("land_use","water","segment","building")}
        self.places={}
        self.counts={key:0 for key in self.fp}

    def emit(self,key,geom,props,owned=False):
        if owned:
            p=feature_point(geom)
            if not p or owner(*p)!=self.idx:return
        self.fp[key].write(json.dumps(line(geom,props),ensure_ascii=False,separators=(",",":"))+"\n")
        self.counts[key]+=1

    def place(self,source,t,point):
        cat=point_category(t)
        nm=name_of(t)
        if not cat or not nm or not point or owner(*point)!=self.idx:return
        ident=ulid(source)
        self.places[ident]={"id":ident,"name":nm,"coordinates":{"longitude":round(point[0],7),"latitude":round(point[1],7)},
            "address":t.get("addr:full") or t.get("addr:street") or "",
            "categories":[cat.title()],"phone":t.get("contact:phone") or t.get("phone") or "",
            "hours":[],"business_status":"UNKNOWN","source":"OpenStreetMap","source_id":source}

    def node(self,n):
        t=tags(n)
        if point_category(t):
            try:self.place("osm:node:"+str(n.id),t,[n.location.lon,n.location.lat])
            except (ValueError,RuntimeError):pass

    def way(self,w):
        t=tags(w)
        try:
            pts=[[n.lon,n.lat] for n in w.nodes]
            if len(pts)<2:return
        except (ValueError,RuntimeError):return
        hw=t.get("highway")
        if hw and hw not in ("proposed","construction"):
            self.emit("segment",{"type":"LineString","coordinates":pts},
                {"class":hw,"subtype":"road","name":name_of(t)},True)
        elif t.get("railway") in ("rail","tram","light_rail"):
            self.emit("segment",{"type":"LineString","coordinates":pts},
                {"class":"rail","subtype":"rail","name":name_of(t)},True)
        if point_category(t):
            self.place("osm:way:"+str(w.id),t,pts[len(pts)//2])

    def area(self,a):
        t=tags(a)
        try: geom=json.loads(self.g.create_multipolygon(a))
        except (ValueError,RuntimeError):return
        if t.get("building") and t["building"]!="no":
            try:height=float(re.sub(r"[^0-9.]","",t.get("height","")) or "0")
            except ValueError:height=0
            self.emit("building",geom,{"height":height if 0<height<800 else 6},True)
        if t.get("natural")=="water" or t.get("waterway") in ("riverbank","dock") or t.get("landuse")=="reservoir":
            self.emit("water",geom,{"class":"water","subtype":t.get("water","")})
        elif t.get("landuse") or t.get("leisure") or t.get("natural") in ("wood","forest","grassland","beach"):
            cls=t.get("landuse") or t.get("leisure") or t.get("natural") or "other"
            self.emit("land_use",geom,{"class":cls,"subtype":cls})
        if point_category(t):
            p=feature_point(geom)
            if p:self.place("osm:area:"+str(a.id),t,p)

    def close(self):
        for f in self.fp.values():f.close()

def import_newmaps(collector,root):
    sys.path.insert(0,str(root/"scripts"))
    try:
        from place_eligibility import classify_place
    except ImportError as e:raise RuntimeError("newmaps public eligibility classifier missing") from e
    accepted=0
    for path in sorted((root/"data"/"places").glob("*/*.json")):
        p=json.loads(path.read_text(encoding="utf8"))
        if not classify_place(p)["eligible_for_public_map"]:continue
        c=p.get("coordinates")
        if not isinstance(c,dict):continue
        lon,lat=c.get("longitude"),c.get("latitude")
        if not isinstance(lon,(int,float)) or not isinstance(lat,(int,float)):continue
        if owner(lon,lat)!=collector.idx:continue
        if not p.get("id") or not p.get("name"):continue
        collector.places[p["id"]]={**p,"source":"MazoPlatforms/newmaps"}
        accepted+=1
    # Prefer reviewed newmaps data when it describes the same named, mapped place.
    reviewed={(p["name"].casefold().strip(),round(p["coordinates"]["longitude"],5),
               round(p["coordinates"]["latitude"],5)) for p in collector.places.values()
              if p.get("source")=="MazoPlatforms/newmaps"}
    collector.places={k:p for k,p in collector.places.items()
                      if p.get("source")=="MazoPlatforms/newmaps" or
                      (p["name"].casefold().strip(),round(p["coordinates"]["longitude"],5),
                       round(p["coordinates"]["latitude"],5)) not in reviewed}
    return accepted

def shard(name):
    import re
    tokens=re.split(r"[\s,.;:()\[\]/\\\-_&'\"]+",name.casefold())
    return {"-".join(f"{ord(c):x}" for c in list(t)[:2]) for t in tokens if len(t)>=2}

def export_places(collector,ddir,idx,search):
    out=ddir/"places"
    out.mkdir(parents=True,exist_ok=True)
    ordered=sorted(collector.places.values(),key=lambda p:p["id"])
    with (collector.tmp/"place.geojsonseq").open("w",encoding="utf8") as fo:
        for pos,p in enumerate(ordered):
            folder=f"{pos//999+1:04d}"
            dest=out/folder
            dest.mkdir(exist_ok=True)
            (dest/(p["id"]+".json")).write_text(json.dumps(p,ensure_ascii=False,separators=(",",":")),encoding="utf8")
            c=p["coordinates"];lon,lat=c["longitude"],c["latitude"]
            geom={"type":"Point","coordinates":[lon,lat]}
            props={"id":p["id"],"f":folder,"d":idx,"name":p["name"],
                   "category":(p.get("categories") or [""])[0]}
            fo.write(json.dumps(line(geom,props),ensure_ascii=False,separators=(",",":"))+"\n")
            row=[p["name"],round(lon,6),round(lat,6),p["id"],folder,idx]
            for key in shard(p["name"]):search.setdefault(key,[]).append(row)
    manifest={"schema":1,"per_folder":999,"folder_width":4,
              "total":len(ordered),"folders":math.ceil(len(ordered)/999)}
    (out/"manifest.json").write_text(json.dumps(manifest))
    return manifest

def run_tiles(out,inputs,minz,maxz):
    if not inputs:return False
    args=["tippecanoe","--force","-o",str(out),f"-Z{minz}",f"-z{maxz}",
          "--read-parallel","--drop-densest-as-needed","--maximum-tile-bytes=400000",
          "--attribution=© OpenStreetMap contributors"]
    for layer,path in inputs:
        args+=["-L",json.dumps({"file":str(path),"layer":layer})]
    subprocess.run(args,check=True)
    if out.stat().st_size>MAX_FILE:
        raise RuntimeError(f"{out}: PMTiles above GitHub's 100MB limit: {out.stat().st_size}")
    return True

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--index",type=int,required=True)
    ap.add_argument("--pbf",type=Path,required=True)
    ap.add_argument("--newmaps",type=Path,required=True)
    ap.add_argument("--public",type=Path,default=Path("public"))
    args=ap.parse_args()
    if args.index not in range(25):raise SystemExit("District zone index must be 0..24")
    idx=args.index;slug=DISTRICTS[idx][0]
    data=args.public/"data"
    temp=Path("build-osm")
    shutil.rmtree(temp,ignore_errors=True);temp.mkdir()
    stage=temp/"district";stage.mkdir()
    collector=Collector(idx,temp)
    try:collector.apply_file(str(args.pbf),locations=True)
    finally:collector.close()
    reviewed=import_newmaps(collector,args.newmaps)
    search={}
    places=export_places(collector,stage,idx,search)
    areas=[(k,temp/(k+".geojsonseq")) for k in ("land_use","water") if collector.counts[k]]
    base=[("segment",temp/"segment.geojsonseq")] if collector.counts["segment"] else []
    if places["total"]:base.append(("place",temp/"place.geojsonseq"))
    buildings=[("building",temp/"building.geojsonseq")] if collector.counts["building"] else []
    files={"areas":run_tiles(stage/"areas.pmtiles",areas,5,14),
           "base":run_tiles(stage/"base.pmtiles",base,8,14),
           "buildings":[]}
    if buildings:
        # Build one file first, then split along latitude if GitHub's file limit
        # requires it. This is tile packaging, not a road/routing partition.
        for bands in (1,2,4,8,16):
            for previous in stage.glob("buildings-*.pmtiles"):previous.unlink()
            outs=[]
            south,north=window(idx)[1],window(idx)[3]
            west,east=window(idx)[0],window(idx)[2]
            try:
                for band in range(bands):
                    b0=south+(north-south)*band/bands
                    b1=south+(north-south)*(band+1)/bands
                    out=stage/f"buildings-{band}.pmtiles"
                    clip=",".join(map(str,(west,b0,east,b1)))
                    args=["tippecanoe","--force","-o",str(out),"-Z15","-z15",
                          "--read-parallel","--drop-densest-as-needed",
                          "--maximum-tile-bytes=400000",
                          "--attribution=© OpenStreetMap contributors",
                          "--clip-bounding-box="+clip,
                          "-L",json.dumps({"file":str(temp/"building.geojsonseq"),"layer":"building"})]
                    subprocess.run(args,check=True)
                    if out.stat().st_size>MAX_FILE:
                        raise RuntimeError("PMTiles above GitHub limit")
                    outs.append(out.name)
            except RuntimeError as exc:
                if "above GitHub limit" not in str(exc):raise
                if bands==16:raise RuntimeError("Building tiles could not be split under 95MB") from exc
                continue
            files["buildings"]=outs
            break
    if not files["base"]:raise RuntimeError("No usable OSM base tiles created")
    # Preserve the existing frontend, routing, custom data, and every other zone.
    target=data/"districts"/slug
    target.mkdir(parents=True,exist_ok=True)
    old=target.with_name(slug+".previous")
    if old.exists():shutil.rmtree(old)
    target.rename(old)
    try:shutil.move(str(stage),str(target))
    except Exception:
        if target.exists():shutil.rmtree(target)
        old.rename(target)
        raise
    shutil.rmtree(old)
    idxpath=data/"districts.json"
    payload=json.loads(idxpath.read_text()) if idxpath.exists() else {"bbox":BBOX,"districts":[]}
    entry={"idx":idx,"slug":slug,"name":slug.replace("-"," ").title(),
           "window":window(idx),"files":files,"counts":{**collector.counts,"place":places["total"]},
           "places":places,"source":"OpenStreetMap + MazoPlatforms/newmaps"}
    payload["districts"]=[*(d for d in payload["districts"] if d["slug"]!=slug),entry]
    payload["districts"].sort(key=lambda d:d["idx"])
    payload["attribution"]="© OpenStreetMap contributors · Mazo Maps"
    idxpath.write_text(json.dumps(payload,separators=(",",":")))
    searchdir=data/"search";searchdir.mkdir(parents=True,exist_ok=True)
    for path in searchdir.glob("*.json"):
        rows=[r for r in json.loads(path.read_text()) if r[5]!=idx]
        rows.extend(search.pop(path.stem,[]))
        if rows:path.write_text(json.dumps(sorted(rows,key=lambda r:r[0].casefold()),ensure_ascii=False,separators=(",",":")))
        else:path.unlink()
    for key,rows in search.items():
        (searchdir/(key+".json")).write_text(json.dumps(sorted(rows,key=lambda r:r[0].casefold()),ensure_ascii=False,separators=(",",":")))
    print(json.dumps({"zone":slug,"osm_features":collector.counts,"places":places["total"],"reviewed_newmaps":reviewed},indent=2))

if __name__=="__main__":main()
