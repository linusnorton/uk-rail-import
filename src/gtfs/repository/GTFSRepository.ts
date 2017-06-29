
import {DatabaseConnection} from "../../database/DatabaseConnection";
import {Transfer} from "../file/Transfer";
import {CRS, Stop} from "../file/Stop";
import {RSID, Schedule, STP, TUID} from "../native/Schedule";
import {StopTime} from "../file/StopTime";
import moment = require("moment");
import {ScheduleCalendar} from "../native/ScheduleCalendar";

/**
 * Provide access to the CIF data in a vaguely GTFS-ish shape.
 */
export class GTFSRepository {

  constructor(
    private readonly db: DatabaseConnection,
    private readonly stream: any
  ) {}

  /**
   * Return the interchange time between each station
   */
  public async getTransfers(): Promise<Transfer[]> {
    // combine the interchange time with fixed links and a reverse of each fixed link (they are bi-directional)
    const [results] = await this.db.query<Transfer[]>(`
      SELECT 
        crs_code AS from_stop_id, 
        crs_code AS to_stop_id, 
        2 AS transfer_type, 
        minimum_change_time * 60 AS duration 
      FROM physical_station
      UNION
      SELECT 
        origin AS from_stop_id, 
        destination AS to_stop_id, 
        2 AS transfer_type, 
        duration * 60 AS duration 
      FROM fixed_link
      UNION
      SELECT 
        destination AS from_stop_id, 
        origin AS to_stop_id, 
        2 AS transfer_type, 
        duration * 60 AS duration 
      FROM fixed_link
    `);

    return results;
  }

  public async getStops(): Promise<Stop[]> {
    const [results] = await this.db.query<Stop[]>(`
      SELECT
        crs_code AS stop_id,             
        tiploc_code AS stop_code,           
        description AS stop_name,           
        description AS stop_desc,           
        NULL AS stop_lat,            
        NULL AS stop_lon,            
        NULL AS zone_id,             
        NULL AS stop_url,            
        NULL AS location_type,       
        NULL AS parent_station,      
        "Europe/London" AS stop_timezone,       
        0 AS wheelchair_boarding 
      FROM tiploc 
      WHERE crs_code IS NOT NULL 
      AND description IS NOT NULL;
    `);

    return results;
  }

  public async getSchedules(): Promise<Schedule[]> {
    return new Promise<Schedule[]>((resolve, reject) => {
      const results = this.stream.query(`
        SELECT
          schedule.id AS id, train_uid, retail_train_id, runs_from, runs_to, 
          monday, tuesday, wednesday, thursday, friday, saturday, sunday, 
          bank_holiday_running, stp_indicator, location, 
          public_arrival_time, public_departure_time, platform
        FROM schedule
        LEFT JOIN schedule_extra ON schedule.id = schedule_extra.schedule
        LEFT JOIN stop_time ON schedule.id = stop_time.schedule
        ORDER BY stop_time.id
      `);

      const schedules: Schedule[] = [];
      let stops: StopTime[] = [];
      let prevSchedule = 1;

      results.on("result", row => {
        stops.push({
          trip_id: row.id,
          arrival_time: row.public_arrival_time,
          departure_time: row.public_departure_time,
          stop_id: row.location,
          stop_sequence: stops.length + 1,
          stop_headsign: row.platform,
          pickup_type: row.public_departure_time ? 0 : 1,
          drop_off_type: row.public_arrival_time ? 0 : 1,
          shape_dist_traveled: null,
          timepoint: 1
        });

        if (prevSchedule !== row.id) {
          schedules.push(new Schedule(
            row.id,
            stops,
            row.train_uid,
            row.retail_train_id,
            new ScheduleCalendar(
              moment(row.runs_from),
              moment(row.runs_to),
              {
                1: row.monday,
                2: row.tuesday,
                3: row.wednesday,
                4: row.thursday,
                5: row.friday,
                6: row.saturday,
                7: row.sunday,
              },
              row.bank_holiday_running
            ),
            row.stp_indicator
          ));

          stops = [];
          prevSchedule = row.id;
        }
      });

      results.on("end", () => {
        // todo push last Schedule
        resolve(schedules);
      });
      results.on("error", reject);
    });
  }

  /**
   * Close the underlying database
   */
  public end(): Promise<any> {
    return Promise.all([this.db.end(), this.stream.end()]);
  }

}

interface ScheduleStopTimeRow {
  id: number,
  train_uid: TUID,
  retail_train_id: RSID,
  runs_from: string,
  runs_to: string,
  monday: 0 | 1,
  tuesday: 0 | 1,
  wednesday: 0 | 1,
  thursday: 0 | 1,
  friday: 0 | 1,
  saturday: 0 | 1,
  sunday: 0 | 1,
  bank_holiday_running: 0 | 1,
  stp_indicator: STP,
  location: CRS,
  public_arrival_time: number,
  public_departure_time: number,
  platform: string
}