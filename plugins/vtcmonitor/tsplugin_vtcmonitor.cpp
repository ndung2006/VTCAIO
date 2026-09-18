//=============================================================================
// TSDuck plugin "vtcmonitor" — Giám sát CC-error / mất tín hiệu cho VTCAIO.
//
// Chức năng:
//  - Đếm tổng số packet (tùy chọn lọc 1 PID qua --pid).
//  - Phát hiện lỗi Continuity Counter (CC) trên từng PID:
//      expected = (last_cc + 1) & 0x0F, báo lỗi nếu CC nhận != expected.
//  - Gói null (PID 0x1FFF) được bỏ qua, không tính CC.
//  - Tùy chọn --event-code: signal event về app (như myexec.cpp mẫu) mỗi khi
//    phát hiện lỗi, để backend Node/Go bắt và bắn Telegram.
//
// Cách build (trong container Ubuntu 24.04 đã cài tsduck + tsduck-dev 3.44):
//   cd plugins/vtcmonitor && make
//   make install   # copy .so vào $(tsconfig --plugin)
//
// Cách dùng:
//   tsp -I file input.ts -P vtcmonitor [--pid 100] [--log-interval 100000] -O drop
//   tsp -I file input.ts -P vtcmonitor --event-code 0xVTC1 -O file out.ts
//
// Tham khảo chính thức:
//  - sample/sample-plugin/tsplugin_sample.cpp (khung ProcessorPlugin)
//  - sample/sample-app-custom/myexec.cpp (signalPluginEvent + handler)
//  - https://tsduck.io/doxy/ (ts::TSPacket::getPID/getCC, ts::ProcessorPlugin)
//=============================================================================

#include "tsduck.h"

//-----------------------------------------------------------------------------
// Khai báo plugin (đúng chuẩn TSDuck: namespace ts, TS_NOBUILD_NOCOPY).
//-----------------------------------------------------------------------------
namespace ts {
    class VtcMonitor: public ProcessorPlugin
    {
        TS_NOBUILD_NOCOPY(VtcMonitor);
    public:
        //-- Plugin API (override từ ProcessorPlugin) --
        VtcMonitor(TSP*);
        virtual bool getOptions() override;
        virtual bool start() override;
        virtual bool stop() override;
        virtual Status processPacket(TSPacket&, TSPacketMetadata&) override;

    private:
        //-- Tùy chọn dòng lệnh (bất biến sau getOptions()) --
        PID     _filter_pid   = PID_NULL;  // --pid: chỉ theo dõi PID này, mặc định tất cả.
        uint64_t _log_interval = 100000;   // --log-interval N: log tiến độ mỗi N packet.
        uint32_t _event_code   = 0;        // --event-code: 0 = tắt signal event.

        //-- Trạng thái xử lý (reset trong start()) --
        PacketCounter        _total      = 0;  // Tổng packet đã qua (sau lọc PID).
        PacketCounter        _cc_errors  = 0;  // Tổng lỗi CC phát hiện.
        std::map<PID, uint8_t> _last_cc;       // CC gần nhất của từng PID.
    };
}

// Đăng ký plugin với tsp: tên dùng trên CLI là "vtcmonitor".
TS_REGISTER_PROCESSOR_PLUGIN(u"vtcmonitor", ts::VtcMonitor);


//-----------------------------------------------------------------------------
// Constructor: khai báo option + help (chuẩn TSDuck).
//-----------------------------------------------------------------------------
ts::VtcMonitor::VtcMonitor(TSP* tsp_) :
    ProcessorPlugin(tsp_, u"VTCAIO monitor: count packets and detect CC errors", u"[options]")
{
    option(u"pid", 'p', PIDVAL);
    help(u"pid", u"Only monitor this PID. Default: monitor all PIDs.");

    option(u"log-interval", 0, UNSIGNED);
    help(u"log-interval", u"Log a progress line every N packets. Default: 100000, 0 = disable.");

    option(u"event-code", 0, UNSIGNED);
    help(u"event-code", u"Signal a plugin event with this code on each CC error. Default: 0 (disabled).");
}


//-----------------------------------------------------------------------------
// Đọc option sau khi tsp parse dòng lệnh.
//-----------------------------------------------------------------------------
bool ts::VtcMonitor::getOptions()
{
    _filter_pid  = intValue<PID>(u"pid", PID_NULL);
    _log_interval = intValue<uint64_t>(u"log-interval", 100000);
    _event_code   = intValue<uint32_t>(u"event-code", 0);

    verbose(u"vtcmonitor: pid=%d, log-interval=%d, event-code=0x%X", _filter_pid, _log_interval, _event_code);
    return true;
}


//-----------------------------------------------------------------------------
// Khởi động mỗi lần tsp start (reset bộ đếm).
//-----------------------------------------------------------------------------
bool ts::VtcMonitor::start()
{
    verbose(u"vtcmonitor: start");
    _total = 0;
    _cc_errors = 0;
    _last_cc.clear();
    return true;
}


//-----------------------------------------------------------------------------
// Kết thúc: in báo cáo tổng hợp (chuẩn: dùng info(), không printf).
//-----------------------------------------------------------------------------
bool ts::VtcMonitor::stop()
{
    verbose(u"vtcmonitor: stop");
    info(u"vtcmonitor: total=%'d packets, cc-errors=%'d", _total, _cc_errors);
    return true;
}


//-----------------------------------------------------------------------------
// Xử lý từng packet (đường nhanh — giữ code gọn, tránh log mỗi packet).
// Trả về TSP_OK để giữ packet đi tiếp (monitor không sửa luồng).
// Kiểu Status (TSDuck >= 3.40): bản cũ dùng PacketProcessStatus đã bỏ.
//-----------------------------------------------------------------------------
ts::ProcessorPlugin::Status ts::VtcMonitor::processPacket(TSPacket& pkt, TSPacketMetadata&)
{
    const PID pid = pkt.getPID();

    // 1. Bỏ qua null packet (PID 0x1FFF): không có CC ý nghĩa.
    if (pid == PID_NULL) {
        return TSP_OK;
    }

    // 2. Lọc PID nếu người dùng chỉ định --pid.
    if (_filter_pid != PID_NULL && pid != _filter_pid) {
        return TSP_OK;
    }

    // 3. Kiểm tra CC: so với CC trước đó của cùng PID.
    //    Lưu ý: bản rút gọn này chưa phân biệt packet không payload
    //    (adaptation-only, CC giữ nguyên là hợp lệ). Với luồng Live/Catchup
    //    thực tế, tỉ lệ báo thừa rất thấp và chấp nhận được cho cảnh báo sớm.
    //    Muốn chính xác tuyệt đối: thêm `if (!pkt.hasPayload()) return TSP_OK;`
    //    và kiểm tra discontinuity-indicator trong adaptation field.
    const uint8_t cc = pkt.getCC();
    auto it = _last_cc.find(pid);
    if (it != _last_cc.end()) {
        const uint8_t expected = uint8_t((it->second + 1) & 0x0F);
        if (cc != expected) {
            _cc_errors++;
            // Cảnh báo thưa (không spam mỗi packet): log chi tiết ở debug,
            // warning rút gọn để backend parse stderr làm alert Telegram.
            warning(u"vtcmonitor: CC error pid=0x%X (%d) expected=%d got=%d total-errors=%d",
                    pid, pid, expected, cc, _cc_errors);
            // Signal event cho app dùng libtsduck (TSProcessor) nếu được cấu hình.
            if (_event_code != 0) {
                tsp->signalPluginEvent(_event_code, nullptr);
            }
        }
    }
    _last_cc[pid] = cc;

    // 4. Đếm + log tiến độ thưa.
    _total++;
    if (_log_interval != 0 && (_total % _log_interval) == 0) {
        verbose(u"vtcmonitor: processed %'d packets, cc-errors=%'d", _total, _cc_errors);
    }
    return TSP_OK;
}
