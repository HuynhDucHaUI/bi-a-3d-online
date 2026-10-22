// Đơn vị: mét, giây, radian. Trục x chạy theo chiều dài bàn, y theo chiều rộng.

export const TABLE_L = 2.54; // chiều dài mặt chơi (bàn 9 ft)
export const TABLE_W = 1.27;
export const BALL_R = 0.028575;
export const BALL_D = BALL_R * 2;

export const G = 9.81;
// Thông số theo đo đạc thực tế (Dr. Dave Alciatore, Han 2005, Mathavan 2010) cho nỉ thi đấu.
export const MU_SLIDE = 0.2; // ma sát trượt bi - nỉ
export const MU_ROLL = 0.014; // ma sát lăn (nỉ thi đấu: 0.005 - 0.015)
export const SPIN_DECEL = 10; // rad/s^2, xoáy ngang (quanh trục dọc) giảm dần
export const BALL_E = 0.95; // hệ số phục hồi bi - bi
// ma sát bi - bi phụ thuộc tốc độ trượt: mu = A + B * exp(-C * v)
export const BALL_MU_A = 0.00995;
export const BALL_MU_B = 0.108;
export const BALL_MU_C = 1.088;
// Băng: mũi băng cao 63,5% đường kính bi (quy chuẩn WPA) -> chạm phía trên tâm một góc theta
export const CUSHION_NOSE_H = 0.635 * 2 * BALL_R;
export const CUSHION_SIN = CUSHION_NOSE_H / BALL_R - 1;
export const CUSHION_COS = Math.sqrt(1 - CUSHION_SIN * CUSHION_SIN);
export const CUSHION_E = 0.86; // hệ số phục hồi khi bi lao vào chậm
export const CUSHION_E_SLOPE = 0.025; // giảm theo tốc độ lao vào (m/s)
export const CUSHION_E_MIN = 0.7;
// ma sát bi - băng (băng pool, đo bởi Dr. Dave / pooltool ~0.2), giảm nhẹ khi đập chéo: mu = MU_0 - SLOPE * beta
export const CUSHION_MU_0 = 0.24;
export const CUSHION_MU_SLOPE = 0.05;
export const CUSHION_MU_MIN = 0.18;
export const STOP_SPEED = 0.004;

export const DT = 0.0005;
export const MAX_SIM_TIME = 60;
export const MAX_SHOT_SPEED = 8;
export const MAX_SPIN_OFFSET = 1; // chuẩn hoá về đĩa đơn vị, tương ứng 0.5R

// Miệng lỗ: vị trí "đầu gờ" của băng
export const CORNER_MOUTH = 0.085;
export const SIDE_MOUTH = 0.06;
export const KNUCKLE_R = 0.006;
export const SIDE_CAPTURE_Y = 0.014;

export const HEAD_STRING_X = TABLE_L / 4;
export const FOOT_SPOT_X = TABLE_L * 0.75;

export const TURN_SECONDS = 60;
export const RECONNECT_SECONDS = 60;
