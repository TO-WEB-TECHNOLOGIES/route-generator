# ops/maps/ — map files you download yourself

Put `.osm.pbf` files here and the OSRM build uses them **instead of downloading**. Everything in
this folder except this README is git-ignored.

## Which files

Any one of these sets, covering Delhi, Gurugram, Noida and Ghaziabad (details and links:
`understanding/05-map-downloads-and-frontend-flow.md`, Part A):

| Option | Files to put here |
|---|---|
| BBBike custom extract (smallest) | the one `.osm.pbf` from the email link |
| Geofabrik zones | `northern-zone-latest.osm.pbf` **and** `central-zone-latest.osm.pbf` |
| openstreetmap.fr states | `national_capital_territory_of_delhi-latest.osm.pbf`, `haryana-latest.osm.pbf`, `uttar_pradesh-latest.osm.pbf` |

Use **one** set, not a mix: every `.pbf` file here is merged in.

## Then

```bash
docker compose -f ops/docker-compose.yml up
```

The prep step checks that each file is complete, cuts it to the NCR box, merges, and the OSRM
container builds and serves the map. Your files here are never changed or deleted.

- **Replacing or adding a file** triggers a rebuild automatically on the next `up`.
- **Removing all files** makes the build download from the URLs in `ops/osrm/prep.Dockerfile`
  again (also triggering a rebuild).
- A half-finished browser download (`.crdownload`, `.part`) is ignored. A truncated `.pbf` is
  rejected with a clear message.
