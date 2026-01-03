import React, { useEffect, useState } from "react";
import axios from "axios";

const API = process.env.REACT_APP_API_BASE_URL || "http://localhost:4000/api";

export default function ManagerOrdersFlow() {
  const [orders, setOrders] = useState([]);
  const [drivers, setDrivers] = useState([]);
  const [selectedOrder, setSelectedOrder] = useState(null);

  const [vehicleNo, setVehicleNo] = useState("");
  const [selectedDriver, setSelectedDriver] = useState("");
  const [step, setStep] = useState(1);
  const [loading, setLoading] = useState(false);

  // ✅ token from localstorage
  const token = localStorage.getItem("token");

  useEffect(() => {
    fetchConfirmedOrders();
    fetchDriversList();
  }, []);

  // ✅ 1) Confirmed Orders fetch
  const fetchConfirmedOrders = async () => {
    try {
      const res = await axios.get(`${API}/orders/confirmed`, {
        headers: { Authorization: `Bearer ${token}` }
      });

      const list = res.data.orders || [];
      setOrders(list);

      if (list.length > 0) {
        setSelectedOrder(list[0]); // ✅ first order auto select
        setStep(1);
      }
    } catch (err) {
      console.log("Orders fetch error:", err.message);
    }
  };

  // ✅ 2) Drivers list fetch
  const fetchDriversList = async () => {
    try {
      const res = await axios.get(`${API}/users/drivers`, {
        headers: { Authorization: `Bearer ${token}` }
      });

      setDrivers(res.data.drivers || []);
    } catch (err) {
      console.log("Drivers fetch error:", err.message);
    }
  };

  // ✅ STEP 1: Vehicle Selected
  const handleVehicleSelect = async () => {
    if (!vehicleNo) return alert("Vehicle No required");

    try {
      setLoading(true);

      await axios.put(
        `${API}/orders/${selectedOrder.orderId}/vehicleSelected`,
        { vehicleType: vehicleNo },
        { headers: { Authorization: `Bearer ${token}` } }
      );

      setStep(2);
    } catch (err) {
      alert(err.response?.data?.message || err.message);
    } finally {
      setLoading(false);
    }
  };

  // ✅ STEP 2: Loading Start
  const handleLoadingStart = async () => {
    try {
      setLoading(true);

      await axios.post(
        `${API}/orders/loadingStart`,
        { orderId: selectedOrder.orderId },
        { headers: { Authorization: `Bearer ${token}` } }
      );

      setStep(3);
    } catch (err) {
      alert(err.response?.data?.message || err.message);
    } finally {
      setLoading(false);
    }
  };

  // ✅ STEP 3: Loading End
  const handleLoadingEnd = async () => {
    try {
      setLoading(true);

      await axios.post(
        `${API}/orders/loadingEnd`,
        { orderId: selectedOrder.orderId },
        { headers: { Authorization: `Bearer ${token}` } }
      );

      setStep(4);
    } catch (err) {
      alert(err.response?.data?.message || err.message);
    } finally {
      setLoading(false);
    }
  };

  // ✅ STEP 4: Assign Driver
  const handleAssignDriver = async () => {
    if (!selectedDriver) return alert("Driver select pannunga");

    try {
      setLoading(true);

      await axios.post(
        `${API}/orders/assignDriver`,
        {
          orderId: selectedOrder.orderId,
          driverId: selectedDriver,
          vehicleNo: vehicleNo
        },
        { headers: { Authorization: `Bearer ${token}` } }
      );

      alert("✅ Driver assigned successfully!");

      // ✅ Next order load
      const currentIndex = orders.findIndex(o => o.orderId === selectedOrder.orderId);
      const nextOrder = orders[currentIndex + 1];

      if (nextOrder) {
        setSelectedOrder(nextOrder);
        setVehicleNo("");
        setSelectedDriver("");
        setStep(1);
      } else {
        alert("✅ All confirmed orders completed!");
      }

    } catch (err) {
      alert(err.response?.data?.message || err.message);
    } finally {
      setLoading(false);
    }
  };

  // ✅ No order case
  if (!selectedOrder) {
    return (
      <div style={{ padding: 20 }}>
        <h3>No confirmed orders available</h3>
      </div>
    );
  }

  return (
    <div style={{ padding: 20, maxWidth: 700 }}>
      <h2>Manager Orders Flow</h2>

      <div style={{ border: "1px solid #ccc", padding: 15, borderRadius: 8 }}>
        <h3>Order ID: {selectedOrder.orderId}</h3>

        {/* ✅ STEP 1 Vehicle select */}
        {step === 1 && (
          <>
            <h4>1️⃣ Vehicle Number Select</h4>

            <select value={vehicleNo} onChange={(e) => setVehicleNo(e.target.value)}>
              <option value="">-- Choose Vehicle --</option>
              {(selectedOrder.availableVehicles || []).map((v) => (
                <option key={v} value={v}>{v}</option>
              ))}
            </select>

            <br /><br />
            <button disabled={loading} onClick={handleVehicleSelect}>
              Next → Loading Start
            </button>
          </>
        )}

        {/* ✅ STEP 2: Items + grand amount + qty */}
        {step === 2 && (
          <>
            <h4>2️⃣ Items Summary</h4>

            <p><b>Grand Amount:</b> ₹{selectedOrder.grandAmount}</p>
            <p><b>Total Qty:</b> {selectedOrder.totalQty}</p>

            <ul>
              {(selectedOrder.items || []).map((it, index) => (
                <li key={index}>
                  {it.productName} - Qty: {it.qty}
                </li>
              ))}
            </ul>

            <button disabled={loading} onClick={handleLoadingStart}>
              ✅ Loading Start
            </button>
          </>
        )}

        {/* ✅ STEP 3: Loading End */}
        {step === 3 && (
          <>
            <h4>3️⃣ Loading Processing...</h4>
            <button disabled={loading} onClick={handleLoadingEnd}>
              ✅ Loading End
            </button>
          </>
        )}

        {/* ✅ STEP 4: Driver assign */}
        {step === 4 && (
          <>
            <h4>4️⃣ Driver Select</h4>

            <select value={selectedDriver} onChange={(e) => setSelectedDriver(e.target.value)}>
              <option value="">-- Choose Driver --</option>
              {drivers.map((d) => (
                <option key={d.pk} value={d.pk}>
                  {d.name} ({d.mobile})
                </option>
              ))}
            </select>

            <br /><br />
            <button disabled={loading} onClick={handleAssignDriver}>
              ✅ Assign Driver
            </button>
          </>
        )}
      </div>
    </div>
  );
}
